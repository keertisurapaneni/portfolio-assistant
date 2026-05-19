/**
 * VWAP Confluence Scanner
 *
 * Detects setups where VWAP, SMA 200, EMA 8, and EMA 21 converge within
 * a tight zone (0.35% of median). When price retests the zone and closes
 * above VWAP, enters long.
 *
 * Purely rule-based — no AI/Gemini calls. Runs on the 15-min scheduler cycle.
 *
 * State machine per ticker:
 *   idle → zone_detected → triggered (enter) → done
 *
 * Resets daily at midnight ET. Time gate: 10:00 AM – 3:30 PM ET.
 */

import type { AutoTraderConfig } from '../../../shared/config-defaults.js';
import type { AccountType } from '../../../shared/trade-types.js';
import { computeEMA, computeEMALatest, computeATR } from './intraday-indicators.js';
import { fetchSessionLevels } from './session-levels.js';

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[VWAPConfluence]';
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};
const TIMEOUT_MS = 12_000;

const CONFLUENCE_THRESHOLD_PCT = 0.35;
const MIN_CONFIDENCE = 7;
const TIME_GATE_START_MINUTES = 10 * 60;       // 10:00 AM ET
const TIME_GATE_END_MINUTES = 15 * 60 + 30;    // 3:30 PM ET

// Day-trade universe: mega-cap tech + liquid ETFs + high-volume names.
// Kept small (~25 tickers) to avoid API overload on Yahoo.
const SCANNER_UNIVERSE = [
  'TSLA', 'AMD', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL',
  'SPY', 'QQQ', 'IWM',
  'NFLX', 'COIN', 'MSTR', 'SMCI', 'ARM', 'AVGO', 'CRM', 'UBER',
  'MU', 'INTC', 'PYPL', 'SQ', 'SHOP', 'PLTR',
];

// ── Types ────────────────────────────────────────────────────────────────────

interface Bar5m {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type ZonePhase = 'idle' | 'zone_detected' | 'triggered' | 'done';

interface TickerState {
  phase: ZonePhase;
  zoneLevels: number[];      // [vwap, ema8, ema21, sma200] when zone detected
  zoneMedian: number;
  triggeredAt: number;
}

// ── Module state (resets daily) ──────────────────────────────────────────────

const _states = new Map<string, TickerState>();
let _lastResetDate = '';

// 5m bar cache per ticker per cycle (avoids re-fetching within same 15-min window)
interface BarCache { bars: Bar5m[]; fetchedAt: number }
const _barCache = new Map<string, BarCache>();
const BAR_CACHE_TTL_MS = 3 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEtNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getEtDateString(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function resetIfNewDay(): void {
  const today = getEtDateString();
  if (today !== _lastResetDate) {
    _states.clear();
    _barCache.clear();
    _lastResetDate = today;
    console.log(`${LOG_PREFIX} Daily state reset`);
  }
}

// ── Yahoo Finance data fetchers ──────────────────────────────────────────────

async function fetch5mBars(ticker: string): Promise<Bar5m[] | null> {
  const key = ticker.toUpperCase();
  const cached = _barCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < BAR_CACHE_TTL_MS) {
    return cached.bars;
  }

  try {
    const encoded = encodeURIComponent(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const opens: (number | null)[] = q.open ?? [];
    const highs: (number | null)[] = q.high ?? [];
    const lows: (number | null)[] = q.low ?? [];
    const closes: (number | null)[] = q.close ?? [];
    const volumes: (number | null)[] = q.volume ?? [];

    const bars: Bar5m[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i], h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
      if (o != null && h != null && l != null && c != null && v != null && v > 0) {
        bars.push({ ts: timestamps[i], open: o, high: h, low: l, close: c, volume: v });
      }
    }

    if (bars.length < 5) return null;
    _barCache.set(key, { bars, fetchedAt: Date.now() });
    return bars;
  } catch {
    return null;
  }
}

/**
 * Fetch SMA 200 from Yahoo quote summary (twoHundredDayAverage field).
 */
async function fetchSMA200(ticker: string): Promise<number | null> {
  try {
    const fields = 'regularMarketPrice,twoHundredDayAverage';
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=${fields}`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data?.quoteResponse?.result?.[0];
    return (q?.twoHundredDayAverage as number) ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute session-anchored VWAP from 5m bars.
 */
function computeVwap(bars: Bar5m[]): number | null {
  let cumTPV = 0;
  let cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumVol += b.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

/**
 * Compute average volume ratio: today's avg volume vs 10-day avg.
 * Uses the bars we already have — coarse estimate.
 */
function volumeRatio(bars: Bar5m[]): number {
  if (bars.length === 0) return 1;
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  // Rough benchmark: typical 5m bar volume for liquid names ≈ 500K–2M.
  // We don't have 10-day history in 5m, so just return a normalized value.
  // The confidence scorer uses >1.3x as a bonus — we'll use bar count as proxy.
  return bars.length >= 20 ? 1.5 : 1.0;
}

// ── Core logic ───────────────────────────────────────────────────────────────

interface ConfluenceResult {
  ticker: string;
  signal: 'BUY';
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  riskReward: string;
  zoneLevels: { vwap: number; ema8: number; ema21: number; sma200: number };
  spreadPct: number;
}

async function analyzeTickerConfluence(ticker: string): Promise<ConfluenceResult | null> {
  const bars = await fetch5mBars(ticker);
  if (!bars || bars.length < 21) return null;

  const closes = bars.map(b => b.close);

  // Compute indicators
  const vwap = computeVwap(bars);
  if (!vwap) return null;

  const ema8Arr = computeEMA(closes, 8);
  const ema21Arr = computeEMA(closes, 21);
  const ema8 = ema8Arr[ema8Arr.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];
  if (isNaN(ema8) || isNaN(ema21)) return null;

  const sma200 = await fetchSMA200(ticker);
  if (!sma200) return null;

  // Check confluence: all 4 levels within 0.35% of their median
  const levels = [vwap, ema8, ema21, sma200].sort((a, b) => a - b);
  const median = (levels[1] + levels[2]) / 2;
  if (median <= 0) return null;

  const maxDev = Math.max(...levels.map(l => Math.abs(l - median) / median * 100));
  if (maxDev > CONFLUENCE_THRESHOLD_PCT) return null;

  const spreadPct = ((levels[3] - levels[0]) / median) * 100;

  // Entry trigger: check last 3 bars for zone touch + VWAP reclaim
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prev2 = bars.length >= 3 ? bars[bars.length - 3] : null;

  const zoneMin = levels[0];
  const zoneMax = levels[3];

  // Prior bar(s) touched the zone (low pierced into zone)
  const priorTouched =
    (prev.low <= zoneMax && prev.low >= zoneMin * 0.998) ||
    (prev2 && prev2.low <= zoneMax && prev2.low >= zoneMin * 0.998);

  if (!priorTouched) return null;

  // Current bar closes above VWAP → long signal
  if (last.close <= vwap) return null;

  // Compute ATR for stop buffer
  const atr = computeATR(
    bars.map(b => ({ high: b.high, low: b.low, close: b.close })),
    14,
  );
  const atrVal = isNaN(atr) ? last.close * 0.003 : atr;

  const entry = last.close;
  const buffer = Math.max(0.001 * entry, 0.3 * atrVal);
  const stop = zoneMin - buffer;

  // Target: pre-market high. If PMH <= entry, use 1.5 * risk.
  const sessionLevels = await fetchSessionLevels(ticker);
  const pmh = sessionLevels.preMarketHigh;
  let target: number;
  if (pmh && pmh > entry) {
    target = pmh;
  } else {
    target = entry + 1.5 * (entry - stop);
  }

  const risk = entry - stop;
  const reward = target - entry;
  if (risk <= 0) return null;
  const rr = reward / risk;

  // Confidence scoring
  let confidence = 6;
  if (spreadPct < 0.25) confidence++;            // tight spread
  if (bars.length >= 20) confidence++;            // volume proxy (enough bars = active session)
  if (last.close > ema8 && ema8 > ema21) confidence++;  // close > ema8 > ema21
  if (rr >= 2.0) confidence++;                    // R:R >= 2.0

  if (confidence < MIN_CONFIDENCE) return null;

  return {
    ticker,
    signal: 'BUY',
    entry: parseFloat(entry.toFixed(2)),
    stop: parseFloat(stop.toFixed(2)),
    target: parseFloat(target.toFixed(2)),
    confidence,
    riskReward: `${rr.toFixed(1)}:1`,
    zoneLevels: {
      vwap: parseFloat(vwap.toFixed(2)),
      ema8: parseFloat(ema8.toFixed(2)),
      ema21: parseFloat(ema21.toFixed(2)),
      sma200: parseFloat(sma200.toFixed(2)),
    },
    spreadPct: parseFloat(spreadPct.toFixed(3)),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the universe for VWAP confluence setups.
 * Called from the 15-min scheduler cycle. Executes qualifying setups
 * through the provided trade execution callback.
 *
 * @param executeTrade  Callback that builds a TradeIdea and calls executeScannerTrade.
 *                      Receives the ConfluenceResult. Returns void.
 */
export async function checkVwapConfluenceSetups(
  executeTrade: (result: ConfluenceResult) => Promise<void>,
): Promise<void> {
  resetIfNewDay();

  // Time gate: 10:00 AM – 3:30 PM ET
  const etNow = getEtNow();
  const etMinutes = etNow.getHours() * 60 + etNow.getMinutes();
  if (etMinutes < TIME_GATE_START_MINUTES || etMinutes > TIME_GATE_END_MINUTES) {
    return;
  }

  console.log(`${LOG_PREFIX} Scanning ${SCANNER_UNIVERSE.length} tickers for confluence zones...`);

  let zonesFound = 0;
  let triggeredCount = 0;

  // Process in batches of 5 to avoid hammering Yahoo
  const BATCH = 5;
  for (let i = 0; i < SCANNER_UNIVERSE.length; i += BATCH) {
    const batch = SCANNER_UNIVERSE.slice(i, i + BATCH);

    const results = await Promise.all(
      batch.map(async (ticker) => {
        const state = _states.get(ticker);
        if (state?.phase === 'done' || state?.phase === 'triggered') return null;

        try {
          return await analyzeTickerConfluence(ticker);
        } catch (err) {
          console.warn(`${LOG_PREFIX} ${ticker}: error —`, err instanceof Error ? err.message : err);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      zonesFound++;

      const existing = _states.get(result.ticker);
      if (existing?.phase === 'done' || existing?.phase === 'triggered') continue;

      console.log(
        `${LOG_PREFIX} ${result.ticker}: CONFLUENCE ZONE — ` +
        `VWAP=$${result.zoneLevels.vwap} EMA8=$${result.zoneLevels.ema8} ` +
        `EMA21=$${result.zoneLevels.ema21} SMA200=$${result.zoneLevels.sma200} ` +
        `(spread ${result.spreadPct}%) | ` +
        `Entry=$${result.entry} Stop=$${result.stop} Target=$${result.target} ` +
        `Conf=${result.confidence} R:R=${result.riskReward}`,
      );

      _states.set(result.ticker, {
        phase: 'triggered',
        zoneLevels: [
          result.zoneLevels.vwap,
          result.zoneLevels.ema8,
          result.zoneLevels.ema21,
          result.zoneLevels.sma200,
        ],
        zoneMedian: (result.zoneLevels.vwap + result.zoneLevels.sma200) / 2,
        triggeredAt: Date.now(),
      });

      try {
        await executeTrade(result);
        _states.set(result.ticker, { ..._states.get(result.ticker)!, phase: 'done' });
        triggeredCount++;
      } catch (err) {
        console.warn(`${LOG_PREFIX} ${result.ticker}: execution error —`, err instanceof Error ? err.message : err);
      }
    }

    // Rate-limit between batches
    if (i + BATCH < SCANNER_UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (zonesFound > 0 || triggeredCount > 0) {
    console.log(`${LOG_PREFIX} Cycle complete: ${zonesFound} zone(s) found, ${triggeredCount} triggered`);
  }
}

export type { ConfluenceResult };
