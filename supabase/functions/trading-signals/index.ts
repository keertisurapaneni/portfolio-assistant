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
  computeATR,
  computeADX,
} from '../_shared/indicators.ts';
import {
  type Mode,
  prepareAnalysisContext,
  MODE_INTERVALS,
} from '../_shared/analysis.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Yahoo Finance: candles via shared data-fetchers, news + market snapshot via shared analysis context. No API key needed.

// Gemini: model cascade + key rotation (Trading Signals only)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Order: highest free-tier RPM first → 2.0-flash-lite (30), 2.0-flash (15), 2.5-flash (10)
const GEMINI_MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];

const REQUEST_TIMEOUT_MS = 90_000; // 90s total for the whole pipeline

type RequestMode = Mode | 'AUTO';

interface RequestPayload {
  ticker: string;
  mode: RequestMode;
}

// MODE_INTERVALS and CANDLE_SIZES imported from _shared/analysis.ts (single source of truth)

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
// Candles, news, market snapshot are all fetched via shared analysis context.
// Only Finnhub fundamentals + earnings calendar are fetched locally.

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
  sharesOutstanding: number | null;  // in millions
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
      sharesOutstanding: m['shareOutstanding'] ?? null,  // Finnhub field name (in millions)
      analystConsensus,
      earnings: earningsData,
    };
  } catch (e) {
    console.warn('[Trading Signals] Fundamentals fetch failed:', e);
    return null;
  }
}

// ── Earnings Calendar (upcoming earnings date) ──────────

interface EarningsEvent {
  date: string;       // YYYY-MM-DD
  hour: string;       // 'bmo' (before market open), 'amc' (after close), 'dmh' (during)
  epsEstimate: number | null;
  revenueEstimate: number | null;
  daysUntil: number;
}

async function fetchEarningsCalendar(ticker: string, finnhubKey: string): Promise<EarningsEvent | null> {
  try {
    const base = 'https://finnhub.io/api/v1';
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    // Look 30 days ahead
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    const to = future.toISOString().slice(0, 10);

    const res = await fetchWithTimeout(
      `${base}/calendar/earnings?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey}`,
      { timeout: 10_000 }
    );
    if (!res.ok) return null;
    const data = await res.json();

    const events = data?.earningsCalendar;
    if (!Array.isArray(events) || events.length === 0) return null;

    // Find the nearest upcoming event for this ticker
    const match = events.find(
      (e: { symbol?: string }) => (e.symbol ?? '').toUpperCase() === ticker.toUpperCase()
    );
    if (!match) return null;

    const earningsDate = new Date(match.date + 'T00:00:00');
    const diffMs = earningsDate.getTime() - today.getTime();
    const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return {
      date: match.date,
      hour: match.hour ?? 'unknown',
      epsEstimate: match.epsEstimate ?? null,
      revenueEstimate: match.revenueEstimate ?? null,
      daysUntil,
    };
  } catch (e) {
    console.warn('[Trading Signals] Earnings calendar fetch failed:', e);
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

// ── Auto mode detection ─────────────────────────────────

async function detectMode(
  ticker: string,
): Promise<{ mode: Mode; reason: string }> {
  // Fetch daily candles for ATR% and ADX (via shared Yahoo fetcher)
  const daily = await fetchCandles(ticker, '1day', 60);
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

// ── Gemini caller (model cascade + round-robin key AND model rotation) ────────

// Both counters persist across calls within the same isolate so parallel calls
// (sentiment, trade, outlook) each start from a DIFFERENT key AND model.
let _geminiKeyIndex = 0;
let _geminiModelOffset = 0;

// Track rate-limited key+model combos so we skip them instead of burning RPM.
// Map key: "modelIdx:keyIdx" → value: timestamp when cooldown expires.
const _rateLimitedUntil: Map<string, number> = new Map();

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

  // Round-robin keys — each call starts from a different key
  const keyStart = _geminiKeyIndex % apiKeys.length;
  _geminiKeyIndex++;

  // Round-robin models — each parallel call starts from a different model so
  // sentiment / trade / outlook don't all hammer flash-lite at once.
  const modelStart = _geminiModelOffset % GEMINI_MODELS.length;
  _geminiModelOffset++;

  const now = Date.now();

  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const modelIdx = (modelStart + m) % GEMINI_MODELS.length;
    const model = GEMINI_MODELS[modelIdx];

    for (let i = 0; i < apiKeys.length; i++) {
      const keyIdx = (keyStart + i) % apiKeys.length;
      const comboKey = `${modelIdx}:${keyIdx}`;

      // Skip combos we already know are rate-limited
      const cooldownUntil = _rateLimitedUntil.get(comboKey);
      if (cooldownUntil && now < cooldownUntil) {
        console.log(
          `[Trading Signals] Skipping ${model} key#${keyIdx} (rate-limited for ${Math.ceil((cooldownUntil - now) / 1000)}s more)`
        );
        continue;
      }

      const key = apiKeys[keyIdx];
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
        // Parse Retry-After if available, otherwise default to 60s cooldown
        const retryAfter = res.headers.get('retry-after');
        const cooldownMs = retryAfter && !isNaN(Number(retryAfter))
          ? Math.min(Number(retryAfter) * 1000, 120_000) // cap at 2 min
          : 60_000;
        _rateLimitedUntil.set(comboKey, Date.now() + cooldownMs);
        console.warn(
          `[Trading Signals] ${model} key#${keyIdx} rate-limited → ${cooldownMs / 1000}s cooldown, trying next combo`
        );
        continue; // try next key (same model) or next model
      }
      // Non-429 error on this model — try next model
      break;
    }
  }

  // Housekeeping: purge expired cooldown entries
  const cleanupNow = Date.now();
  for (const [k, v] of _rateLimitedUntil) {
    if (cleanupNow > v) _rateLimitedUntil.delete(k);
  }

  const errText = lastResponse ? await lastResponse.text().catch(() => '') : '';
  throw new Error(
    `Gemini API failed (all models/keys exhausted): ${lastResponse?.status ?? 'unknown'} ${errText.slice(0, 200)}`
  );
}

// ── Shared prompts (single source of truth) ─────────────
import {
  DAY_TRADE_SYSTEM,
  DAY_TRADE_RULES,
  SWING_TRADE_SYSTEM,
  SWING_TRADE_RULES,
} from '../_shared/prompts.ts';
import { fetchCandles } from '../_shared/data-fetchers.ts';
import { buildFeedbackContext } from '../_shared/feedback.ts';

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
// System prompt + rules imported from shared prompts (single source of truth)

const DAY_TRADE_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 1m/15m/1h candles (validation), (3) News headlines (confirmation only).

${DAY_TRADE_RULES}

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
// System prompt + rules imported from shared prompts (single source of truth)

const SWING_TRADE_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 4h/1d/1w candles (validation), (3) News headlines (must not contradict technicals).

${SWING_TRADE_RULES}

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

    // Candle data + market snapshot fetched via shared Yahoo Finance fetcher (no API key needed).
    // This ensures scanner and full analysis use the exact same data source.

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
      detectedMode = await detectMode(ticker);
      mode = detectedMode.mode;
      console.log(`[Trading Signals] AUTO → ${mode} (${detectedMode.reason})`);
    } else {
      mode = requestedMode;
    }

    // ── Step 1-3: Shared analysis context (same code as scanner Pass 2) ──
    // Fetch Finnhub fundamentals + earnings in parallel with the shared context
    const finnhubKey = Deno.env.get('FINNHUB_API_KEY');
    const [ctx, fundamentals, earningsEvent, feedbackCtx] = await Promise.all([
      prepareAnalysisContext(ticker, mode),
      finnhubKey ? fetchFundamentals(ticker, finnhubKey) : Promise.resolve(null),
      finnhubKey ? fetchEarningsCalendar(ticker, finnhubKey) : Promise.resolve(null),
      buildFeedbackContext(),
    ]);

    if (!ctx) {
      return new Response(
        JSON.stringify({ error: 'Could not fetch candle data for this symbol. Try again or check the ticker.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { indicators, indicatorText: indicatorPromptText, candles: timeframes, trimmedCandles, currentPrice, marketSnapshot, news, ohlcvBars } = ctx;
    const intervals = MODE_INTERVALS[mode];
    const technicalData = { timeframes: trimmedCandles, currentPrice };

    // Format news for prompts
    const newsForPrompt = news.slice(0, 15).map(n => ({
      headline: n.headline,
      source: n.source,
    }));
    const newsForTrade = newsForPrompt.length > 0
      ? newsForPrompt
      : [{ headline: 'No recent news available', source: '' }];

    // Float context for day trade (shares outstanding from Finnhub fundamentals)
    let extraContext = '';
    if (mode === 'DAY_TRADE' && fundamentals?.sharesOutstanding != null) {
      const shares = fundamentals.sharesOutstanding; // in millions
      const floatLabel = shares < 20 ? 'LOW FLOAT — expect explosive moves, wider spreads'
        : shares < 100 ? 'MID FLOAT — moderate volatility'
        : shares < 500 ? 'LARGE FLOAT — steadier price action'
        : 'MEGA FLOAT — slow grinder, tight stops appropriate';
      extraContext += `\nShares Outstanding: ${shares < 1000 ? `${Math.round(shares)}M` : `${(shares / 1000).toFixed(1)}B`} — ${floatLabel}`;
    }

    // Earnings calendar context (both modes)
    if (earningsEvent) {
      const d = earningsEvent.daysUntil;
      const hourLabel = earningsEvent.hour === 'bmo' ? 'before market open'
        : earningsEvent.hour === 'amc' ? 'after market close'
        : earningsEvent.hour === 'dmh' ? 'during market hours' : '';
      if (d <= 0) {
        extraContext += `\n⚠️ EARNINGS JUST REPORTED (${earningsEvent.date}${hourLabel ? ' ' + hourLabel : ''}) — expect elevated volume and volatility.`;
      } else if (d <= 7) {
        extraContext += `\n⚠️ EARNINGS IN ${d} DAY${d > 1 ? 'S' : ''} (${earningsEvent.date}${hourLabel ? ' ' + hourLabel : ''}) — binary event risk.`;
      } else {
        extraContext += `\nEarnings upcoming: ${earningsEvent.date} (${d} days out).`;
      }
    }

    const tradeSystemPrompt = mode === 'DAY_TRADE' ? DAY_TRADE_SYSTEM : SWING_TRADE_SYSTEM;
    const tradeUserTemplate = mode === 'DAY_TRADE' ? DAY_TRADE_USER : SWING_TRADE_USER;
    const tradeUserPrompt = tradeUserTemplate
      .replace('{{INDICATOR_SUMMARY}}', indicatorPromptText + extraContext + feedbackCtx)
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
