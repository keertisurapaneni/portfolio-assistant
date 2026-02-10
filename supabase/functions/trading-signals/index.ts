// Portfolio Assistant — Trading Signals Edge Function
//
// Mental model (no mixing):
//   Twelve Data → candles → Indicator Engine → enriched AI prompt → Gemini trade agent
//   Yahoo Finance → articles → sentiment agent (Gemini)
//   Twelve Data → SPY + VIX → market context → AI prompt
//
// Returns { trade, chart, indicators, marketSnapshot, longTermOutlook } for Day, Swing, or Auto mode.
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
// Every mode also gets a "Long Term Outlook" section powered by Finnhub fundamentals.
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

interface CandleResult {
  values: Candle[];
  rateLimited?: undefined;
}
interface CandleRateLimited {
  values?: undefined;
  rateLimited: true;
}
type CandleFetchResult = CandleResult | CandleRateLimited | null;

async function fetchCandles(
  symbol: string,
  interval: string,
  apikey: string,
  outputsize = 150
): Promise<CandleFetchResult> {
  const url = `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${apikey}`;
  const res = await fetchWithTimeout(url, { timeout: 20_000 });
  if (res.status === 429) {
    console.warn(`[Trading Signals] Twelve Data 429 for ${symbol} ${interval}`);
    return { rateLimited: true };
  }
  if (!res.ok) return null;
  const data = await res.json();
  if (data.code === 429 || (data.status === 'error' && /rate limit|too many/i.test(data.message ?? ''))) {
    console.warn(`[Trading Signals] Twelve Data rate-limited (in-body) for ${symbol} ${interval}: ${data.message}`);
    return { rateLimited: true };
  }
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

// ── Finnhub fundamentals (Long Term Outlook) ───────────

interface FundamentalData {
  pe: number | null;
  eps: number | null;
  roe: number | null;
  profitMargin: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  marketCap: number | null;
  beta: number | null;
  week52High: number | null;
  week52Low: number | null;
  analystConsensus: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
  earnings: { quarter: string; actual: number | null; estimate: number | null; surprise: number | null }[];
}

async function fetchFundamentals(ticker: string, finnhubKey: string): Promise<FundamentalData | null> {
  try {
    const base = 'https://finnhub.io/api/v1';
    const [metricsRes, recsRes, earningsRes] = await Promise.all([
      fetchWithTimeout(`${base}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${finnhubKey}`, { timeout: 10_000 }),
      fetchWithTimeout(`${base}/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${finnhubKey}`, { timeout: 10_000 }),
      fetchWithTimeout(`${base}/stock/earnings?symbol=${encodeURIComponent(ticker)}&token=${finnhubKey}`, { timeout: 10_000 }),
    ]);

    const metrics = metricsRes.ok ? await metricsRes.json() : null;
    const recs = recsRes.ok ? await recsRes.json() : [];
    const earnings = earningsRes.ok ? await earningsRes.json() : [];

    const m = metrics?.metric ?? {};

    // Latest analyst consensus (most recent period)
    let analystConsensus = null;
    if (Array.isArray(recs) && recs.length > 0) {
      const latest = recs[0]; // newest first
      analystConsensus = {
        strongBuy: latest.strongBuy ?? 0,
        buy: latest.buy ?? 0,
        hold: latest.hold ?? 0,
        sell: latest.sell ?? 0,
        strongSell: latest.strongSell ?? 0,
      };
    }

    // Last 4 quarterly earnings
    const earningsData = (Array.isArray(earnings) ? earnings.slice(0, 4) : []).map(
      (e: { period?: string; actual?: number; estimate?: number; surprise?: number }) => ({
        quarter: e.period ?? '',
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        surprise: e.surprise ?? null,
      })
    );

    return {
      pe: m['peTTM'] ?? m['peAnnual'] ?? null,
      eps: m['epsTTM'] ?? m['epsAnnual'] ?? null,
      roe: m['roeTTM'] ?? m['roeAnnual'] ?? null,
      profitMargin: m['netProfitMarginTTM'] ?? m['netProfitMarginAnnual'] ?? null,
      revenueGrowth: m['revenueGrowthTTMYoy'] ?? m['revenueGrowthQuarterlyYoy'] ?? null,
      epsGrowth: m['epsGrowthTTMYoy'] ?? m['epsGrowthQuarterlyYoy'] ?? null,
      marketCap: m['marketCapitalization'] ?? null,
      beta: m['beta'] ?? null,
      week52High: m['52WeekHigh'] ?? null,
      week52Low: m['52WeekLow'] ?? null,
      analystConsensus,
      earnings: earningsData,
    };
  } catch (e) {
    console.warn('[Trading Signals] Fundamentals fetch failed:', e);
    return null;
  }
}

function formatFundamentalsForPrompt(f: FundamentalData, currentPrice: number | null): string {
  const lines: string[] = ['FUNDAMENTAL DATA (from Finnhub):'];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  lines.push('Valuation & Profitability:');
  if (f.pe != null) lines.push(`  P/E (TTM): ${f.pe.toFixed(1)}`);
  if (f.eps != null) lines.push(`  EPS (TTM): $${f.eps.toFixed(2)}`);
  if (f.roe != null) lines.push(`  ROE: ${f.roe.toFixed(1)}%`);
  if (f.profitMargin != null) lines.push(`  Profit Margin: ${f.profitMargin.toFixed(1)}%`);
  if (f.marketCap != null) {
    const cap = f.marketCap >= 1000 ? `$${(f.marketCap / 1000).toFixed(0)}B` : `$${f.marketCap.toFixed(0)}M`;
    lines.push(`  Market Cap: ${cap}`);
  }
  if (f.beta != null) lines.push(`  Beta: ${f.beta.toFixed(2)}`);

  lines.push('');
  lines.push('Growth:');
  if (f.revenueGrowth != null) lines.push(`  Revenue Growth (YoY): ${f.revenueGrowth.toFixed(1)}%`);
  if (f.epsGrowth != null) lines.push(`  EPS Growth (YoY): ${f.epsGrowth.toFixed(1)}%`);

  if (currentPrice != null && f.week52High != null && f.week52Low != null) {
    const range = f.week52High - f.week52Low;
    const pctFromHigh = range > 0 ? ((f.week52High - currentPrice) / range * 100).toFixed(0) : '?';
    lines.push('');
    lines.push(`52-Week Range: $${f.week52Low.toFixed(2)} – $${f.week52High.toFixed(2)} (${pctFromHigh}% below high)`);
  }

  if (f.analystConsensus) {
    const a = f.analystConsensus;
    const total = a.strongBuy + a.buy + a.hold + a.sell + a.strongSell;
    lines.push('');
    lines.push('Analyst Consensus:');
    lines.push(`  Strong Buy: ${a.strongBuy}, Buy: ${a.buy}, Hold: ${a.hold}, Sell: ${a.sell}, Strong Sell: ${a.strongSell} (total: ${total})`);
    if (total > 0) {
      const bullish = ((a.strongBuy + a.buy) / total * 100).toFixed(0);
      lines.push(`  Bullish: ${bullish}%`);
    }
  }

  if (f.earnings.length > 0) {
    lines.push('');
    lines.push('Recent Earnings (last 4 quarters):');
    for (const e of f.earnings) {
      if (e.actual != null && e.estimate != null) {
        const beat = e.actual >= e.estimate ? 'BEAT' : 'MISS';
        const surprise = e.surprise != null ? ` (${e.surprise > 0 ? '+' : ''}${(e.surprise * 100).toFixed(1)}%)` : '';
        lines.push(`  ${e.quarter}: Actual $${e.actual.toFixed(2)} vs Est $${e.estimate.toFixed(2)} — ${beat}${surprise}`);
      }
    }
  }

  return lines.join('\n');
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
  if (daily?.rateLimited) {
    return { mode: 'SWING_TRADE', reason: 'Market data rate-limited — defaulting to swing' };
  }
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

const DAY_TRADE_SYSTEM = `You are a disciplined intraday trader. You find actionable setups from pre-computed indicators and price data. Give BUY or SELL when the data supports it; HOLD when there is no edge. You never chase extended moves.`;

const DAY_TRADE_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 1m/15m/1h candles (validation), (3) News headlines (confirmation only).

Rules:
- Indicators determine bias FIRST; candles validate.
- RSI > 70 = overbought caution. RSI < 30 = oversold opportunity.
- MACD histogram confirms momentum. ADX > 25 = trending; < 20 = ranging.
- Price vs EMA(20)/SMA(50) = short/medium trend. ATR sets stop distances.
- Support/resistance = entry/exit zones.
- Directional call when indicators mostly agree. Lower confidence if some conflict.
- HOLD only when indicators genuinely conflict across the board.

Don't chase:
- "Recent Price Move" is the most important filter. Up 10%+ in 5 bars or 20%+ in 10 bars = EXTENDED.
- NEVER BUY an extended/parabolic stock. Extended + RSI > 70 = HOLD or SELL.
- "Strong uptrend" after a big run ≠ buy. It means wait for pullback.
- Gap up on news/earnings = don't chase. Note the pullback level where it becomes attractive.

Risk:
- Entry near current price. Stop = 1-1.5× ATR beyond a key level.
- Target 1 = nearest S/R. Target 2 = next level. Min 1.5× reward-to-risk.

Output (STRICT JSON only, no markdown):
{"mode":"DAY_TRADE","recommendation":"BUY"|"SELL"|"HOLD","bias":"short phrase","entryPrice":number|null,"stopLoss":number|null,"targetPrice":number|null,"targetPrice2":number|null,"riskReward":"1:x"|null,"rationale":{"technical":"2-3 sentences","sentiment":"1 sentence","risk":"1-2 sentences"},"confidence":0-10,"scenarios":{"bullish":{"probability":0-100,"summary":"1 sentence"},"neutral":{"probability":0-100,"summary":"1 sentence"},"bearish":{"probability":0-100,"summary":"1 sentence"}}}
Scenario probabilities must sum to 100.

---
{{INDICATOR_SUMMARY}}

Candles:
{{TECHNICAL_DATA}}

News:
{{SENTIMENT_DATA}}`;

// ── Swing Trade Agent ───────────────────────────────────

const SWING_TRADE_SYSTEM = `You are a disciplined swing trader with 20 years experience. You find multi-day setups from pre-computed indicators and price data. Give BUY or SELL when data supports it; HOLD when there is no edge. You buy pullbacks to support, never after a stock already rallied 30%+.`;

const SWING_TRADE_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 4h/1d/1w candles (validation), (3) News headlines (must not contradict technicals).

Rules:
- Indicators determine bias FIRST; candles validate.
- SMA(200) = long-term trend. SMA(50) = medium-term. Above both = uptrend; below both = downtrend.
- ADX > 25 = trending; < 20 = ranging/choppy. RSI divergences signal reversals.
- MACD crossovers confirm momentum shifts. ATR sets multi-day stop distances.
- Support/resistance = entry/exit zones.
- Directional call when indicators mostly agree. HOLD when genuinely conflicting or tight range + low ADX.
- Counter-trend only if reward > 2.5× risk.

Don't chase:
- "Recent Price Move" is the most important filter. Up 15%+ in 5 bars, 25%+ in 10, or 40%+ in 20 = EXTENDED.
- NEVER BUY an extended stock. Extended + RSI > 70 = HOLD or SELL, never BUY.
- A 30-50% rally = "wait for pullback to SMA20/SMA50," not "buy the trend."
- Gap up on preliminary earnings/news = extra caution. Preliminary ≠ final. Don't chase until dust settles.
- When HOLD on extended stock, include the pullback level where it WOULD become a buy.

Risk:
- Entry near key support (BUY) or resistance (SELL). Stop = 1.5-2× ATR beyond swing level.
- Target 1 = nearest major S/R. Target 2 = next level. Min 1.5× reward-to-risk.

Output (STRICT JSON only, no markdown):
{"mode":"SWING_TRADE","recommendation":"BUY"|"SELL"|"HOLD","bias":"short phrase","entryPrice":number|null,"stopLoss":number|null,"targetPrice":number|null,"targetPrice2":number|null,"riskReward":"1:x"|null,"rationale":{"technical":"2-3 sentences","sentiment":"1 sentence","risk":"1-2 sentences"},"confidence":0-10,"scenarios":{"bullish":{"probability":0-100,"summary":"1 sentence"},"neutral":{"probability":0-100,"summary":"1 sentence"},"bearish":{"probability":0-100,"summary":"1 sentence"}}}
Scenario probabilities must sum to 100.

---
{{INDICATOR_SUMMARY}}

Candles:
{{TECHNICAL_DATA}}

News:
{{SENTIMENT_DATA}}`;

// ── Long Term Outlook Agent ─────────────────────────────

const OUTLOOK_SYSTEM = `You are a fundamental equity analyst. Given a stock's financial metrics, analyst ratings, and recent earnings results, rate whether this stock is a good long-term hold. Be concise and decisive.`;

const OUTLOOK_USER = `Rate this stock as a long-term investment (months to years) based on the fundamental data below.

Rules:
- Focus on earnings quality, growth trajectory, valuation, and analyst consensus.
- Earnings beat/miss consistency shows execution reliability.
- P/E relative to growth rate (PEG concept) matters more than P/E alone.
- Strong revenue + EPS growth with improving margins = bullish.
- Declining growth, high P/E, shrinking margins = bearish.
- If data is insufficient, default to Neutral with low confidence.

Output ONLY valid JSON (no markdown, no backticks):
{
  "rating": "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell",
  "score": number 1-10 (1 = strong sell, 10 = strong buy),
  "summary": "2-3 sentences explaining why",
  "keyFactors": ["factor 1", "factor 2", "factor 3"]
}

{{FUNDAMENTAL_DATA}}`;

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

    // Fetch Finnhub fundamentals in parallel (for Long Term Outlook section)
    const finnhubKey = Deno.env.get('FINNHUB_API_KEY');
    const fundamentalsPromise = finnhubKey
      ? fetchFundamentals(ticker, finnhubKey)
      : Promise.resolve(null);

    const [candles1, candles2, candles3, news, marketSnapshot, fundamentals] = await Promise.all([
      ...candlePromises,
      newsPromise,
      marketPromise,
      fundamentalsPromise,
    ]);

    const candleResults = [candles1, candles2, candles3];
    const rateLimitedCount = candleResults.filter(r => r?.rateLimited).length;

    const timeframes: Record<string, { values: Candle[] }> = {};
    if (candles1?.values) timeframes[intervals[0]] = candles1 as CandleResult;
    if (candles2?.values) timeframes[intervals[1]] = candles2 as CandleResult;
    if (candles3?.values) timeframes[intervals[2]] = candles3 as CandleResult;

    // If most candle fetches were rate-limited, tell the user clearly instead of sending
    // empty data to the AI (which produces a misleading generic HOLD).
    if (rateLimitedCount >= 2) {
      return new Response(
        JSON.stringify({ error: 'Market data API rate limit reached — please wait 60 seconds and try again.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (Object.keys(timeframes).length === 0) {
      return new Response(
        JSON.stringify({ error: 'Could not fetch candle data for this symbol. The market data API may be temporarily unavailable.' }),
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

    // Guard: if the indicator candles are too few, the AI would get empty/garbage indicators
    // and return a misleading HOLD. Fail clearly instead.
    if (ohlcvBars.length < 30) {
      const wasRateLimited = rateLimitedCount > 0;
      return new Response(
        JSON.stringify({
          error: wasRateLimited
            ? 'Market data API rate limit reached — not enough candle data for reliable analysis. Please wait 60 seconds and try again.'
            : `Insufficient candle data for ${ticker} (got ${ohlcvBars.length} bars, need 30+). The market may be closed or this symbol may not have enough trading history.`,
        }),
        {
          status: wasRateLimited ? 429 : 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

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

    // ── Step 4: Sentiment + Trade + Outlook Agents IN PARALLEL ──
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

    // Long Term Outlook — lightweight fundamental assessment (runs in parallel, ~300 tokens)
    const outlookPromise = (async (): Promise<{
      rating: string;
      score: number;
      summary: string;
      keyFactors: string[];
    } | null> => {
      if (!fundamentals) return null;
      try {
        const fundamentalText = formatFundamentalsForPrompt(fundamentals, currentPrice);
        const outlookUserPrompt = OUTLOOK_USER.replace('{{FUNDAMENTAL_DATA}}', fundamentalText);
        const raw = await callGemini(GEMINI_KEYS, OUTLOOK_SYSTEM, outlookUserPrompt, 0.1, 400);
        const parsed = JSON.parse(cleanJson(raw));
        return {
          rating: parsed.rating ?? 'Neutral',
          score: typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5,
          summary: parsed.summary ?? '',
          keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.slice(0, 5) : [],
        };
      } catch (e) {
        console.warn('[Trading Signals] Outlook agent failed:', e);
        return null;
      }
    })();

    const [sentiment, tradeRaw, longTermOutlook] = await Promise.all([
      sentimentPromise,
      tradePromise,
      outlookPromise,
    ]);

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
      longTermOutlook: longTermOutlook ?? null,
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
