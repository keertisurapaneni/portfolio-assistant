// Portfolio Assistant — Trading Signals Edge Function
//
// Mental model (no mixing):
//   Twelve Data → candles → (indicators) → AI trade agent (Gemini)
//   Yahoo Finance → articles → sentiment agent (Gemini) → AI trade agent (Gemini)
//
// Returns { trade, chart } for Day or Swing mode.
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
// 5) What we fetch per request:
//    Day Trade:  Twelve Data 1m, 15m, 1h  |  Yahoo Finance news
//    Swing Trade: Twelve Data 4h, 1d, 1w  |  Yahoo Finance news
//
// 6) Rule: Whatever data the AI sees must be exactly what the chart shows.
//    We use the same timeframes (and same primary series) for both; no separate chart fetch.

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

interface RequestPayload {
  ticker: string;
  mode: Mode;
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
        console.warn(`[Trading Signals] ${model} key#${(startIdx + i) % apiKeys.length} rate-limited, waiting 2s...`);
        await new Promise(r => setTimeout(r, 2000));
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

const DAY_TRADE_SYSTEM = `You are a professional intraday trader. You MUST pick a side.

Rules:
- If the 1-hour trend is UP → recommend BUY with a dip entry near 15-min support.
- If the 1-hour trend is DOWN → recommend SELL with a bounce entry near 15-min resistance.
- HOLD is only allowed when the 1-hour chart shows no direction (flat EMAs, <0.5% range in last 2 hours).
- You must ALWAYS provide entry, stop, target, and risk/reward numbers.`;

const DAY_TRADE_USER = `You are provided with:

1) Technical price action data across three intraday timeframes:
   - 1 minute candles (entry precision)
   - 15 minute candles (intraday structure)
   - 1 hour candles (trend bias)

Each candle includes: time, open, high, low, close, volume.

2) A 24-hour news sentiment analysis containing:
   - sentiment category (Positive / Neutral / Negative)
   - numerical score (-1 to +1)
   - rationale summarizing recent news impact

---

Analysis rules:
- Use the 1-hour timeframe to determine intraday trend bias.
- Use the 15-minute timeframe to assess momentum and structure.
- Use the 1-minute timeframe to refine entries and stops.
- Use sentiment only as confirmation or caution, not the primary driver.
- If price action is choppy or extended, lower your confidence but still look for the best directional lean.

Risk management:
- Entry must be near current price.
- Stop-loss must be placed beyond a recent intraday swing.
- Target must provide at least 1.5× reward relative to risk.
- Widen stops if needed rather than defaulting to HOLD.

Use the most recent 1-minute close as the proxy for current market price.

---

Output format (STRICT – no extra text):

{
  "mode": "DAY_TRADE",
  "recommendation": "BUY | SELL | HOLD",
  "entryPrice": number | null,
  "stopLoss": number | null,
  "targetPrice": number | null,
  "riskReward": "1:x" | null,
  "rationale": {
    "technical": "1-2 sentences on price action and levels",
    "sentiment": "1 sentence on news impact",
    "risk": "1 sentence on risk/reward and stop placement"
  },
  "confidence": "LOW | MEDIUM | HIGH"
}

---

Technical Data:
{{TECHNICAL_DATA}}

Sentiment Data:
{{SENTIMENT_DATA}}`;

// ── Swing Trade Agent ───────────────────────────────────

const SWING_TRADE_SYSTEM = `You are a professional swing trader. You MUST pick a side.

Rules:
- If the dominant trend is UP → recommend BUY with a pullback entry.
- If the dominant trend is DOWN → recommend SELL with a rally entry.
- HOLD is only allowed when price has been in a tight sideways range (<3% range) for 2+ weeks.
- A stock that just dropped hard is a SELL candidate, not a HOLD.
- A stock that just rallied hard is a BUY candidate on a pullback, not a HOLD.
- You must ALWAYS provide entry, stop, target, and risk/reward numbers.`;

const SWING_TRADE_USER = `You are provided with:

1) Technical price action data across three higher timeframes:
   - 4 hour candles (setup structure)
   - Daily candles (trend confirmation)
   - Weekly candles (macro trend context)

Each candle includes: time, open, high, low, close, volume.

2) A 24-hour to multi-day news sentiment analysis containing:
   - sentiment category (Positive / Neutral / Negative)
   - numerical score (-1 to +1)
   - rationale summarizing the dominant market narrative

---

Analysis rules:
- Identify the dominant trend using the weekly timeframe.
- Confirm trend strength using the daily timeframe.
- Use the 4-hour timeframe to define a precise entry zone.
- Sentiment must support or at least not contradict the technical trend.
- If higher timeframes conflict, trade the dominant timeframe's direction with lower confidence and a wider stop.

Risk management:
- Entry should be near a recent support (BUY) or resistance (SELL) level.
- Stop-loss beyond the nearest swing high/low.
- Target at least 1.5× reward relative to risk.
- Counter-trend trades are allowed if reward exceeds 2× risk.

Use the most recent 4-hour close as the proxy for current market price.

---

Output format (STRICT – no extra text):

{
  "mode": "SWING_TRADE",
  "recommendation": "BUY | SELL | HOLD",
  "entryPrice": number | null,
  "stopLoss": number | null,
  "targetPrice": number | null,
  "riskReward": "1:x" | null,
  "rationale": {
    "technical": "1-2 sentences on trend and levels",
    "sentiment": "1 sentence on news impact",
    "risk": "1 sentence on risk/reward and stop placement"
  },
  "confidence": "LOW | MEDIUM | HIGH"
}

---

Technical Data:
{{TECHNICAL_DATA}}

Sentiment Data:
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
    // Collect Gemini API keys (supports 1–4 keys for rotation)
    const GEMINI_KEYS: string[] = [];
    const k1 = Deno.env.get('GEMINI_API_KEY');
    const k2 = Deno.env.get('GEMINI_API_KEY_2');
    const k3 = Deno.env.get('GEMINI_API_KEY_3');
    const k4 = Deno.env.get('GEMINI_API_KEY_4');
    if (k1) GEMINI_KEYS.push(k1);
    if (k2) GEMINI_KEYS.push(k2);
    if (k3) GEMINI_KEYS.push(k3);
    if (k4) GEMINI_KEYS.push(k4);

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
    const mode: Mode = body?.mode === 'DAY_TRADE' ? 'DAY_TRADE' : 'SWING_TRADE';

    if (!ticker) {
      return new Response(JSON.stringify({ error: 'Missing or invalid ticker' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Step 1 + 2: Fetch candles AND news in parallel ──
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

    const [candles1, candles2, candles3, news] = await Promise.all([
      ...candlePromises,
      newsPromise,
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

    // ── Step 3: Sentiment Agent (Gemini) ──
    let sentiment = {
      category: 'Neutral',
      score: 0,
      summary: 'No news available.',
      keyDrivers: [] as string[],
    };
    if (newsForPrompt.length > 0) {
      const sentimentText = await callGemini(
        GEMINI_KEYS,
        SENTIMENT_SYSTEM,
        `News for ${ticker}:\n${JSON.stringify(newsForPrompt)}`
      );
      try {
        const parsed = JSON.parse(cleanJson(sentimentText));
        sentiment = {
          category: parsed.category ?? 'Neutral',
          score: typeof parsed.score === 'number' ? parsed.score : 0,
          summary: parsed.summary ?? '',
          keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers : [],
        };
      } catch {
        // keep default sentiment
      }
    }

    // ── Step 4: Trade Agent (Gemini) ──
    // Twelve Data returns candles newest-first. Use the first candle of the
    // shortest interval as "current price" (most recent data point).
    const technicalData = { timeframes, currentPrice: null as number | null };
    const primaryInterval = intervals[0]; // 4h for swing, 1min for day
    const primaryCandles = timeframes[primaryInterval]?.values;
    if (primaryCandles?.length) {
      const newest = primaryCandles[0];
      const c = parseFloat(newest.close);
      if (!Number.isNaN(c)) technicalData.currentPrice = c;
    }

    const tradeSystemPrompt = mode === 'DAY_TRADE' ? DAY_TRADE_SYSTEM : SWING_TRADE_SYSTEM;
    const tradeUserTemplate = mode === 'DAY_TRADE' ? DAY_TRADE_USER : SWING_TRADE_USER;
    const tradeUserPrompt = tradeUserTemplate
      .replace('{{TECHNICAL_DATA}}', JSON.stringify(technicalData))
      .replace('{{SENTIMENT_DATA}}', JSON.stringify(sentiment));
    const tradeRaw = await callGemini(GEMINI_KEYS, tradeSystemPrompt, tradeUserPrompt);
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

    const response = {
      trade: {
        mode: trade.mode ?? mode,
        recommendation: trade.recommendation ?? 'HOLD',
        entryPrice: trade.entryPrice ?? null,
        stopLoss: trade.stopLoss ?? null,
        targetPrice: trade.targetPrice ?? null,
        riskReward: trade.riskReward ?? null,
        rationale: trade.rationale ?? {},
        confidence: trade.confidence ?? 'MEDIUM',
      },
      chart: {
        timeframe: chartInterval,
        candles: chartCandles,
        overlays: [
          trade.entryPrice != null && { type: 'line', label: 'Entry', price: trade.entryPrice },
          trade.stopLoss != null && { type: 'line', label: 'Stop', price: trade.stopLoss },
          trade.targetPrice != null && { type: 'line', label: 'Target', price: trade.targetPrice },
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
