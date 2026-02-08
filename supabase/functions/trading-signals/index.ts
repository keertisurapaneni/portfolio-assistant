// Portfolio Assistant — Trading Signals Edge Function
//
// Mental model (no mixing):
//   Twelve Data → candles → Indicator Engine → enriched AI prompt → Gemini trade agent
//   Yahoo Finance → articles → sentiment agent (Gemini)
//   Twelve Data → SPY + VIX → market context → AI prompt
//
// Returns { trade, chart, indicators, marketSnapshot } for Day, Swing, or Auto mode.
//
// LLM split across the app:
//   Groq   = Portfolio AI (ai-proxy)
//   Gemini = Trading Signals (this function)
//   [TBD]  = Suggested Finds
//
// Optional upgrades later (swap without changing prompts):
//   Candles: Polygon.io (faster intraday), Alpaca Market Data (if trading later)
//   News: Finnhub (finance-only), Alpha Vantage News
//
// Modes:
//   AUTO       — fetches daily candles first to decide Day vs Swing via ATR% + ADX
//   DAY_TRADE  — 1m, 15m, 1h candles + news
//   SWING_TRADE — 4h, 1d, 1w candles + news
//
// Rule: Whatever data the AI sees must be exactly what the chart shows.

import {
  type OHLCV,
  type IndicatorSummary,
  computeAllIndicators,
  computeATR,
  computeADX,
  formatIndicatorsForPrompt,
} from './indicators.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
// Twelve Data: supports all required timeframes, same feed for AI + chart, free tier OK for MVP.
// GET /time_series?symbol=SYMBOL&interval=1d&outputsize=150&apikey=KEY → datetime, open, high, low, close, volume
const YAHOO_NEWS_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
// Yahoo Finance news: no API key needed, already used elsewhere in the app (fetch-yahoo-news).

// Gemini: model cascade + key rotation (Trading Signals only)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Order: highest free-tier RPM first → 2.0-flash-lite (30), 2.0-flash (15), 2.5-flash (10)
const GEMINI_MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];

const REQUEST_TIMEOUT_MS = 90_000; // 90s total for the whole pipeline

type Mode = 'DAY_TRADE' | 'SWING_TRADE';
type RequestMode = Mode | 'AUTO';

interface RequestPayload {
  ticker: string;
  mode: RequestMode;
}

// Timeframes per mode — same data feeds the AI and the chart.
// Day Trade: 1m (entry), 15m (structure), 1h (trend). Swing: 4h (setup), 1d (trend), 1w (macro).
const MODE_INTERVALS: Record<Mode, [string, string, string]> = {
  DAY_TRADE: ['1min', '15min', '1h'],
  SWING_TRADE: ['4h', '1day', '1week'],
};

interface Candle {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface NewsItem {
  headline: string;
  summary?: string;
  source?: string;
  datetime: number;
  url: string;
}

// ── Helpers ──────────────────────────────────────────────

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = 15_000, ...rest } = options;
  return fetch(url, { ...rest, signal: timeoutSignal(timeout) });
}

// ── Data fetchers ───────────────────────────────────────

async function fetchCandles(
  symbol: string,
  interval: string,
  apikey: string,
  outputsize = 150
): Promise<{ values: Candle[] } | null> {
  const url = `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${apikey}`;
  const res = await fetchWithTimeout(url, { timeout: 20_000 });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status === 'error' || !data.values) return null;
  return { values: data.values };
}

async function fetchYahooNews(symbol: string): Promise<NewsItem[]> {
  const url = `${YAHOO_NEWS_URL}?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=20`;
  const res = await fetchWithTimeout(url, {
    timeout: 10_000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  if (!data?.news || !Array.isArray(data.news)) return [];
  return data.news.map(
    (item: {
      title?: string;
      publisher?: string;
      link?: string;
      providerPublishTime?: number;
    }) => ({
      headline: item.title ?? '',
      summary: item.title ?? '',
      source: item.publisher ?? 'Yahoo Finance',
      url: item.link ?? '',
      datetime: item.providerPublishTime ? item.providerPublishTime * 1000 : 0,
    })
  );
}

// ── Market snapshot (SPY + VIX) ─────────────────────────

interface MarketSnapshot {
  bias: string;
  volatility: string;
  spyTrend: string;
  vix: number;
}

async function fetchMarketSnapshot(apiKey: string): Promise<MarketSnapshot | null> {
  try {
    const [spyRes, vixRes] = await Promise.all([
      fetchCandles('SPY', '1day', apiKey, 60),
      fetchCandles('VIX', '1day', apiKey, 5),
    ]);

    if (!spyRes?.values?.length || !vixRes?.values?.length) return null;

    // Convert to OHLCV (newest-first already from Twelve Data)
    const spyBars: OHLCV[] = spyRes.values.map(v => ({
      o: parseFloat(v.open), h: parseFloat(v.high),
      l: parseFloat(v.low), c: parseFloat(v.close),
      v: v.volume ? parseFloat(v.volume) : 0,
    }));

    const vixClose = parseFloat(vixRes.values[0].close);
    const spyPrice = spyBars[0].c;

    // SMA(50) for SPY trend
    let sma50 = 0;
    const len = Math.min(50, spyBars.length);
    for (let i = 0; i < len; i++) sma50 += spyBars[i].c;
    sma50 /= len;

    const spyTrend = spyPrice > sma50 ? 'Bullish (above SMA50)' : 'Bearish (below SMA50)';
    const bias = spyPrice > sma50 ? 'Bullish' : 'Bearish';

    let volatility: string;
    if (vixClose < 15) volatility = 'Low';
    else if (vixClose < 20) volatility = 'Moderate';
    else if (vixClose < 30) volatility = 'High';
    else volatility = 'Extreme';

    return { bias, volatility, spyTrend, vix: Math.round(vixClose * 10) / 10 };
  } catch (e) {
    console.warn('[Trading Signals] Market snapshot fetch failed:', e);
    return null;
  }
}

// ── Auto mode detection ─────────────────────────────────

async function detectMode(
  ticker: string,
  apiKey: string
): Promise<{ mode: Mode; reason: string }> {
  // Fetch daily candles for ATR% and ADX
  const daily = await fetchCandles(ticker, '1day', apiKey, 60);
  if (!daily?.values?.length || daily.values.length < 30) {
    return { mode: 'SWING_TRADE', reason: 'Insufficient daily data — defaulting to swing' };
  }

  const bars: OHLCV[] = daily.values.map(v => ({
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low), c: parseFloat(v.close),
    v: v.volume ? parseFloat(v.volume) : 0,
  }));

  const currentPrice = bars[0].c;
  const atr = computeATR(bars);
  const adx = computeADX(bars);

  const atrPct = atr !== null && currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

  // High ATR% (> 2%) + strong volume activity → day trade
  // Otherwise swing trade
  if (atrPct > 2 && (adx === null || adx > 20)) {
    return {
      mode: 'DAY_TRADE',
      reason: `ATR ${atrPct.toFixed(1)}% > 2% with ${adx !== null ? `ADX ${adx.toFixed(0)}` : 'unknown ADX'} — high intraday volatility favors day trading`,
    };
  }

  return {
    mode: 'SWING_TRADE',
    reason: `ATR ${atrPct.toFixed(1)}% ≤ 2%${adx !== null ? `, ADX ${adx.toFixed(0)}` : ''} — lower volatility favors swing trading`,
  };
}

// ── Gemini caller (model cascade + round-robin key rotation) ────────

let _geminiKeyIndex = 0; // round-robin counter persists across calls within same invocation

async function callGemini(
  apiKeys: string[],
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.2,
  maxOutputTokens = 2000
): Promise<string> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let lastResponse: Response | null = null;

  // Round-robin: start from the next key each call so all keys share the load
  const startIdx = _geminiKeyIndex % apiKeys.length;
  _geminiKeyIndex++;

  for (const model of GEMINI_MODELS) {
    for (let i = 0; i < apiKeys.length; i++) {
      const key = apiKeys[(startIdx + i) % apiKeys.length];
      const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeout: 45_000,
      });

      if (res.ok) {
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }

      lastResponse = res;
      if (res.status === 429) {
        console.warn(`[Trading Signals] ${model} key#${(startIdx + i) % apiKeys.length} rate-limited, waiting 500ms...`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      // Non-429 error on this model — try next model
      break;
    }
  }

  const errText = lastResponse ? await lastResponse.text().catch(() => '') : '';
  throw new Error(
    `Gemini API failed (all models/keys exhausted): ${lastResponse?.status ?? 'unknown'} ${errText.slice(0, 200)}`
  );
}

// ── System prompts ──────────────────────────────────────

// ── Sentiment Agent ─────────────────────────────────────

const SENTIMENT_SYSTEM = `You are a news sentiment analyst for equity trading. Given a list of recent news headlines and summaries for a stock, output a single structured sentiment assessment.

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "category": "Positive" | "Neutral" | "Negative",
  "score": number between -1 and 1,
  "summary": "1-3 sentence summary of the dominant narrative",
  "keyDrivers": ["short phrase 1", "short phrase 2"]
}`;

// ── Day Trade Agent ─────────────────────────────────────

const DAY_TRADE_SYSTEM = `You are a professional intraday trader. Your job is to find actionable trade setups using pre-computed technical indicators and price action data. Lean toward giving a directional call (BUY or SELL) when the data supports it, but recommend HOLD when there is genuinely no edge.`;

const DAY_TRADE_USER = `You are provided with:

1) Pre-computed technical indicators (RSI, MACD, EMA/SMA, ATR, ADX, volume, support/resistance).
   These are the PRIMARY input — use them to assess trend, momentum, volatility, and key levels.

2) Recent price candles across three intraday timeframes (1m, 15m, 1h) for validation.

3) Recent news headlines for the stock. Assess the sentiment yourself:
   - Use sentiment only as confirmation or caution, not the primary driver.

---

Analysis rules:
- Use indicators to determine the overall bias FIRST, then validate with candles.
- RSI > 70 = overbought caution, RSI < 30 = oversold opportunity.
- MACD histogram direction confirms momentum.
- Price relative to EMA(20)/SMA(50) determines short/medium trend.
- ADX > 25 means trend is strong enough to trade; ADX < 20 means ranging.
- ATR sets realistic stop-loss distances.
- Support/resistance levels define key entry/exit zones.
- If indicators mostly agree on direction, give a directional call. Use lower confidence if some conflict.
- Only recommend HOLD when indicators genuinely conflict across the board.

Risk management:
- Entry must be near current price.
- Stop-loss should be based on ATR (1-1.5x ATR from entry) and placed beyond a key level.
- Target 1 (conservative): nearest resistance (BUY) or support (SELL).
- Target 2 (stretch): next resistance/support beyond Target 1.
- Minimum 1.5× reward-to-risk for Target 1.
- If the setup is marginal, widen the stop and lower confidence rather than defaulting to HOLD.

---

Output format (STRICT — respond ONLY with valid JSON, no markdown, no backticks, no extra text):

{
  "mode": "DAY_TRADE",
  "recommendation": "BUY" | "SELL" | "HOLD",
  "bias": "short phrase describing the setup, e.g. Bullish continuation, Bearish reversal, Range / Wait",
  "entryPrice": number | null,
  "stopLoss": number | null,
  "targetPrice": number | null,
  "targetPrice2": number | null,
  "riskReward": "1:x" | null,
  "rationale": {
    "technical": "2-3 sentences on indicator readings and price action",
    "sentiment": "1 sentence on news impact",
    "risk": "1-2 sentences on risk/reward, stop placement, and key levels"
  },
  "confidence": number between 0 and 10 (0 = no edge, 10 = strongest conviction),
  "scenarios": {
    "bullish": { "probability": number 0-100, "summary": "1 sentence" },
    "neutral": { "probability": number 0-100, "summary": "1 sentence" },
    "bearish": { "probability": number 0-100, "summary": "1 sentence" }
  }
}

The three scenario probabilities must sum to 100.

---

{{INDICATOR_SUMMARY}}

Recent Candles (for validation):
{{TECHNICAL_DATA}}

News Headlines:
{{SENTIMENT_DATA}}`;

// ── Swing Trade Agent ───────────────────────────────────

const SWING_TRADE_SYSTEM = `You are a professional swing trader. Your job is to find actionable multi-day trade setups using pre-computed technical indicators and price action data. Lean toward giving a directional call (BUY or SELL) when the data supports it, but recommend HOLD when there is genuinely no edge.`;

const SWING_TRADE_USER = `You are provided with:

1) Pre-computed technical indicators (RSI, MACD, EMA/SMA, ATR, ADX, volume, support/resistance).
   These are the PRIMARY input — use them to assess trend, momentum, volatility, and key levels.

2) Recent price candles across three higher timeframes (4h, 1d, 1w) for validation.

3) Recent news headlines for the stock.
   - Sentiment must support or at least not contradict the technical trend.

---

Analysis rules:
- Use indicators to determine the overall bias FIRST, then validate with candles.
- SMA(200) determines the long-term trend; SMA(50) the medium-term.
- Price above both = strong uptrend. Price below both = strong downtrend.
- ADX > 25 confirms a tradeable trend; ADX < 20 signals ranging/choppy market.
- RSI divergences from price signal potential reversals.
- MACD crossovers confirm momentum shifts.
- ATR determines appropriate stop distances for multi-day holds.
- Support/resistance levels define key entry/exit zones.
- If indicators mostly agree on direction, give a directional call. Use lower confidence if some conflict.
- Only recommend HOLD when indicators genuinely conflict or price is in a tight range with low ADX.
- Counter-trend trades are allowed only if reward exceeds 2.5× risk.

Risk management:
- Entry should be near a key support (BUY) or resistance (SELL) level.
- Stop-loss based on ATR (1.5-2x ATR from entry) and placed beyond a significant swing level.
- Target 1 (conservative): nearest major resistance (BUY) or support (SELL).
- Target 2 (stretch): next major level beyond Target 1.
- Minimum 1.5× reward-to-risk for Target 1.

---

Output format (STRICT — respond ONLY with valid JSON, no markdown, no backticks, no extra text):

{
  "mode": "SWING_TRADE",
  "recommendation": "BUY" | "SELL" | "HOLD",
  "bias": "short phrase describing the setup, e.g. Bullish continuation, Bearish reversal, Range / Wait",
  "entryPrice": number | null,
  "stopLoss": number | null,
  "targetPrice": number | null,
  "targetPrice2": number | null,
  "riskReward": "1:x" | null,
  "rationale": {
    "technical": "2-3 sentences on indicator readings and price action",
    "sentiment": "1 sentence on news impact",
    "risk": "1-2 sentences on risk/reward, stop placement, and key levels"
  },
  "confidence": number between 0 and 10 (0 = no edge, 10 = strongest conviction),
  "scenarios": {
    "bullish": { "probability": number 0-100, "summary": "1 sentence" },
    "neutral": { "probability": number 0-100, "summary": "1 sentence" },
    "bearish": { "probability": number 0-100, "summary": "1 sentence" }
  }
}

The three scenario probabilities must sum to 100.

---

{{INDICATOR_SUMMARY}}

Recent Candles (for validation):
{{TECHNICAL_DATA}}

News Headlines:
{{SENTIMENT_DATA}}`;

// ── JSON cleaner ────────────────────────────────────────

function cleanJson(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json?\s*/g, '')
    .replace(/```/g, '')
    .trim();
}

// ── Main handler ────────────────────────────────────────

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

  try {
    // Collect Gemini API keys dynamically (GEMINI_API_KEY, GEMINI_API_KEY_2, _3, …)
    const GEMINI_KEYS: string[] = [];
    const primary = Deno.env.get('GEMINI_API_KEY');
    if (primary) GEMINI_KEYS.push(primary);
    for (let i = 2; ; i++) {
      const k = Deno.env.get(`GEMINI_API_KEY_${i}`);
      if (!k) break;
      GEMINI_KEYS.push(k);
    }

    if (GEMINI_KEYS.length === 0) {
      return new Response(JSON.stringify({ error: 'No GEMINI_API_KEY configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const TWELVE_DATA_API_KEY = Deno.env.get('TWELVE_DATA_API_KEY');

    if (!TWELVE_DATA_API_KEY) {
      return new Response(JSON.stringify({ error: 'TWELVE_DATA_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: RequestPayload = await req.json();
    const ticker = (body?.ticker ?? '').toString().trim().toUpperCase();
    const requestedMode: RequestMode = body?.mode === 'DAY_TRADE'
      ? 'DAY_TRADE'
      : body?.mode === 'AUTO'
        ? 'AUTO'
        : 'SWING_TRADE';

    if (!ticker) {
      return new Response(JSON.stringify({ error: 'Missing or invalid ticker' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Step 0: Auto mode detection (if requested) ──
    let mode: Mode;
    let detectedMode: { mode: Mode; reason: string } | null = null;
    if (requestedMode === 'AUTO') {
      detectedMode = await detectMode(ticker, TWELVE_DATA_API_KEY);
      mode = detectedMode.mode;
      console.log(`[Trading Signals] AUTO → ${mode} (${detectedMode.reason})`);
    } else {
      mode = requestedMode;
    }

    // ── Step 1: Fetch candles + news + market snapshot in parallel ──
    const intervals = MODE_INTERVALS[mode];
    // More candles for daily/weekly so swing charts show 2-3 years of history
    const CANDLE_SIZES: Record<string, number> = {
      '1min': 150, '15min': 150, '1h': 150,
      '4h': 250, '1day': 600, '1week': 150,
    };
    const candlePromises = intervals.map(int =>
      fetchCandles(ticker, int, TWELVE_DATA_API_KEY, CANDLE_SIZES[int] ?? 150)
    );
    const newsPromise = fetchYahooNews(ticker);
    const marketPromise = fetchMarketSnapshot(TWELVE_DATA_API_KEY);

    const [candles1, candles2, candles3, news, marketSnapshot] = await Promise.all([
      ...candlePromises,
      newsPromise,
      marketPromise,
    ]);

    const timeframes: Record<string, { values: Candle[] }> = {};
    if (candles1?.values) timeframes[intervals[0]] = candles1;
    if (candles2?.values) timeframes[intervals[1]] = candles2;
    if (candles3?.values) timeframes[intervals[2]] = candles3;

    if (Object.keys(timeframes).length === 0) {
      return new Response(
        JSON.stringify({ error: 'Could not fetch candle data for this symbol' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const newsForPrompt = news.slice(0, 15).map(n => ({
      headline: n.headline,
      summary: n.summary ?? '',
      source: n.source,
      datetime: n.datetime,
      url: n.url,
    }));

    // ── Step 2: Compute technical indicators ──
    // Use the primary timeframe candles for indicator computation
    // Day Trade: use 15m candles (structure), Swing: use 1day candles (trend)
    const indicatorInterval = mode === 'DAY_TRADE' ? '15min' : '1day';
    const indicatorCandles = timeframes[indicatorInterval]?.values ?? timeframes[intervals[0]]?.values ?? [];
    const ohlcvBars: OHLCV[] = indicatorCandles.map(v => ({
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      v: v.volume ? parseFloat(v.volume) : 0,
    }));

    const indicators: IndicatorSummary = computeAllIndicators(ohlcvBars);

    // Current price from the newest candle of the primary entry timeframe
    const primaryInterval = intervals[0]; // 1min for day, 4h for swing
    const primaryCandles = timeframes[primaryInterval]?.values;
    let currentPrice: number | null = null;
    if (primaryCandles?.length) {
      const c = parseFloat(primaryCandles[0].close);
      if (!Number.isNaN(c)) currentPrice = c;
    }

    // ── Step 3: Build enriched prompt ──
    const marketCtxStr = marketSnapshot
      ? `SPY: ${marketSnapshot.spyTrend} | VIX: ${marketSnapshot.vix} (${marketSnapshot.volatility} fear)`
      : undefined;
    const indicatorPromptText = currentPrice
      ? formatIndicatorsForPrompt(indicators, currentPrice, marketCtxStr)
      : '';

    // Trim candle data — send only last 40 candles of each timeframe for validation
    const trimmedTimeframes: Record<string, unknown> = {};
    for (const [tf, data] of Object.entries(timeframes)) {
      trimmedTimeframes[tf] = data.values.slice(0, 40).map(v => ({
        t: v.datetime,
        o: parseFloat(v.open),
        h: parseFloat(v.high),
        l: parseFloat(v.low),
        c: parseFloat(v.close),
        v: v.volume ? parseFloat(v.volume) : 0,
      }));
    }
    const technicalData = { timeframes: trimmedTimeframes, currentPrice };

    // Give the trade agent the actual news headlines so it can assess sentiment itself
    const newsForTrade = newsForPrompt.length > 0
      ? newsForPrompt.map(n => ({ headline: n.headline, source: n.source }))
      : [{ headline: 'No recent news available', source: '' }];

    const tradeSystemPrompt = mode === 'DAY_TRADE' ? DAY_TRADE_SYSTEM : SWING_TRADE_SYSTEM;
    const tradeUserTemplate = mode === 'DAY_TRADE' ? DAY_TRADE_USER : SWING_TRADE_USER;
    const tradeUserPrompt = tradeUserTemplate
      .replace('{{INDICATOR_SUMMARY}}', indicatorPromptText)
      .replace('{{TECHNICAL_DATA}}', JSON.stringify(technicalData))
      .replace('{{SENTIMENT_DATA}}', JSON.stringify(newsForTrade));

    // ── Step 4: Sentiment Agent + Trade Agent IN PARALLEL ──
    const sentimentPromise = (async () => {
      const defaultSentiment = {
        category: 'Neutral',
        score: 0,
        summary: 'No news available.',
        keyDrivers: [] as string[],
      };
      if (newsForPrompt.length === 0) return defaultSentiment;
      try {
        const sentimentText = await callGemini(
          GEMINI_KEYS,
          SENTIMENT_SYSTEM,
          `News for ${ticker}:\n${JSON.stringify(newsForPrompt)}`
        );
        const parsed = JSON.parse(cleanJson(sentimentText));
        return {
          category: parsed.category ?? 'Neutral',
          score: typeof parsed.score === 'number' ? parsed.score : 0,
          summary: parsed.summary ?? '',
          keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers : [],
        };
      } catch {
        return defaultSentiment;
      }
    })();

    const tradePromise = callGemini(GEMINI_KEYS, tradeSystemPrompt, tradeUserPrompt);

    const [sentiment, tradeRaw] = await Promise.all([sentimentPromise, tradePromise]);

    let trade: Record<string, unknown>;
    try {
      trade = JSON.parse(cleanJson(tradeRaw));
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid trade agent response', raw: tradeRaw.slice(0, 500) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Step 5: Build response ──
    // Chart = same data the AI saw (rule 6). Primary: 15m for day, 1d for swing.
    const chartInterval = mode === 'DAY_TRADE' ? '15min' : '1day';
    const chartSource = timeframes[chartInterval] ?? timeframes[intervals[0]];
    const chartCandles = (chartSource?.values ?? []).map(v => ({
      t: v.datetime,
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      v: v.volume ? parseFloat(v.volume) : 0,
    }));

    // Normalize confidence to 0-10 number
    const rawConf = trade.confidence;
    let confidence: number;
    if (typeof rawConf === 'number' && !isNaN(rawConf)) {
      confidence = Math.max(0, Math.min(10, rawConf));
    } else if (typeof rawConf === 'string') {
      // Try parsing numeric strings first (AI often returns "7" or "7.5")
      const parsed = parseFloat(rawConf);
      if (!isNaN(parsed)) {
        confidence = Math.max(0, Math.min(10, parsed));
      } else {
        // Fallback for legacy qualitative values
        confidence = rawConf.toUpperCase() === 'HIGH' ? 8 : rawConf.toUpperCase() === 'MEDIUM' ? 5 : rawConf.toUpperCase() === 'LOW' ? 3 : 5;
      }
    } else {
      confidence = 5;
    }

    // Parse scenarios with defaults
    const rawScenarios = trade.scenarios as Record<string, { probability?: number; summary?: string }> | undefined;
    const scenarios = {
      bullish: {
        probability: rawScenarios?.bullish?.probability ?? 33,
        summary: rawScenarios?.bullish?.summary ?? '',
      },
      neutral: {
        probability: rawScenarios?.neutral?.probability ?? 34,
        summary: rawScenarios?.neutral?.summary ?? '',
      },
      bearish: {
        probability: rawScenarios?.bearish?.probability ?? 33,
        summary: rawScenarios?.bearish?.summary ?? '',
      },
    };

    const response = {
      trade: {
        mode: trade.mode ?? mode,
        ...(detectedMode ? { detectedMode: detectedMode.mode, autoReason: detectedMode.reason } : {}),
        recommendation: trade.recommendation ?? 'HOLD',
        bias: (trade.bias as string) ?? '',
        entryPrice: trade.entryPrice ?? null,
        stopLoss: trade.stopLoss ?? null,
        targetPrice: trade.targetPrice ?? null,
        targetPrice2: trade.targetPrice2 ?? null,
        riskReward: trade.riskReward ?? null,
        rationale: trade.rationale ?? {},
        confidence,
        scenarios,
      },
      indicators: {
        rsi: indicators.rsi,
        macd: indicators.macd,
        ema20: indicators.ema20,
        sma50: indicators.sma50,
        sma200: indicators.sma200,
        atr: indicators.atr,
        adx: indicators.adx,
        volumeRatio: indicators.volumeRatio?.ratio ?? null,
        emaCrossover: indicators.emaCrossover,
        trend: indicators.trend,
      },
      marketSnapshot: marketSnapshot ?? null,
      chart: {
        timeframe: chartInterval,
        candles: chartCandles,
        overlays: [
          trade.entryPrice != null && { type: 'line', label: 'Entry', price: trade.entryPrice },
          trade.stopLoss != null && { type: 'line', label: 'Stop', price: trade.stopLoss },
          trade.targetPrice != null && { type: 'line', label: 'Target 1', price: trade.targetPrice },
          trade.targetPrice2 != null && { type: 'line', label: 'Target 2', price: trade.targetPrice2 },
        ].filter(Boolean),
      },
    };

    clearTimeout(timeoutId);
    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : 'Unknown error';
    const isAbort =
      message.includes('abort') || (err instanceof Error && err.name === 'AbortError');
    return new Response(JSON.stringify({ error: isAbort ? 'Request timeout' : message }), {
      status: isAbort ? 504 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
