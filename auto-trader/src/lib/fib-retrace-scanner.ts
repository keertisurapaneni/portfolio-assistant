/**
 * Fibonacci 0.236 Retracement Rejection Scanner
 *
 * Detects intraday trends on 5m bars, computes Fibonacci levels from
 * swing high/low, and triggers when price wicks into the 0.236 level
 * then closes back on the trend side (rejection/bounce signal).
 *
 * Purely rule-based — no AI/Gemini calls. Runs on the 15-min scheduler cycle.
 *
 * State machine per ticker:
 *   idle → trend_detected → triggered (enter) → done
 *
 * Resets daily at midnight ET. Time gate: 10:00 AM – 3:30 PM ET.
 */

import type { AutoTraderConfig } from '../../../shared/config-defaults.js';
import type { AccountType } from '../../../shared/trade-types.js';
import { computeEMALatest, computeATR } from './intraday-indicators.js';
import { fetchSessionLevels } from './session-levels.js';

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[FibRetrace]';
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};
const TIMEOUT_MS = 12_000;

const MIN_CONFIDENCE = 7;
const LOOKBACK_BARS = 12;  // ~1 hour of 5m bars for trend detection
const TIME_GATE_START_MINUTES = 10 * 60;     // 10:00 AM ET
const TIME_GATE_END_MINUTES = 15 * 60 + 30;  // 3:30 PM ET

// Same universe as the confluence scanner
const SCANNER_UNIVERSE = [
  'TSLA', 'AMD', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL',
  'SPY', 'QQQ', 'IWM',
  'NFLX', 'COIN', 'MSTR', 'SMCI', 'ARM', 'AVGO', 'CRM', 'UBER',
  'MU', 'INTC', 'PYPL', 'SQ', 'SHOP', 'PLTR',
];

// Fibonacci levels
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1.0] as const;

// ── Types ────────────────────────────────────────────────────────────────────

interface Bar5m {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type FibPhase = 'idle' | 'triggered' | 'done';

interface TickerState {
  phase: FibPhase;
  direction: 'long' | 'short';
  triggeredAt: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const _states = new Map<string, TickerState>();
let _lastResetDate = '';

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

// ── Yahoo data fetch ─────────────────────────────────────────────────────────

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

    if (bars.length < LOOKBACK_BARS) return null;
    _barCache.set(key, { bars, fetchedAt: Date.now() });
    return bars;
  } catch {
    return null;
  }
}

// ── Trend detection ──────────────────────────────────────────────────────────

type TrendDirection = 'up' | 'down' | 'ambiguous';

/**
 * Detect intraday trend from the last `LOOKBACK_BARS` 5m bars.
 * Uptrend: close > EMA21, higher lows pattern (at least 3 of 4 consecutive pairs).
 * Downtrend: close < EMA21, lower highs pattern.
 */
function detectTrend(bars: Bar5m[]): { direction: TrendDirection; swingHigh: number; swingLow: number } {
  const recent = bars.slice(-LOOKBACK_BARS);
  if (recent.length < LOOKBACK_BARS) {
    return { direction: 'ambiguous', swingHigh: 0, swingLow: 0 };
  }

  const closes = bars.map(b => b.close);
  const ema21 = computeEMALatest(closes, 21);
  const lastClose = recent[recent.length - 1].close;

  const swingHigh = Math.max(...recent.map(b => b.high));
  const swingLow = Math.min(...recent.map(b => b.low));

  if (isNaN(ema21)) {
    return { direction: 'ambiguous', swingHigh, swingLow };
  }

  // Higher lows count
  let higherLows = 0;
  let lowerHighs = 0;
  const pairCount = recent.length - 1;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low > recent[i - 1].low) higherLows++;
    if (recent[i].high < recent[i - 1].high) lowerHighs++;
  }

  const hlRatio = higherLows / pairCount;
  const lhRatio = lowerHighs / pairCount;

  if (lastClose > ema21 && hlRatio >= 0.5) {
    return { direction: 'up', swingHigh, swingLow };
  }
  if (lastClose < ema21 && lhRatio >= 0.5) {
    return { direction: 'down', swingHigh, swingLow };
  }

  return { direction: 'ambiguous', swingHigh, swingLow };
}

// ── Fibonacci computation ────────────────────────────────────────────────────

function computeFibLevel(swingHigh: number, swingLow: number, level: number, trendDir: 'up' | 'down'): number {
  if (trendDir === 'up') {
    // Uptrend bounce: fib from high to low (retracement of the up move)
    // 0 = swing high, 1 = swing low
    return swingLow + (swingHigh - swingLow) * (1 - level);
  } else {
    // Downtrend bounce: fib from low to high (retracement of the down move)
    // 0 = swing low, 1 = swing high
    return swingLow + (swingHigh - swingLow) * level;
  }
}

// ── Core analysis ────────────────────────────────────────────────────────────

export interface FibRetraceResult {
  ticker: string;
  signal: 'BUY' | 'SELL';
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  riskReward: string;
  trendDirection: 'up' | 'down';
  swingHigh: number;
  swingLow: number;
  fib236Level: number;
  fib382Level: number;
}

async function analyzeTickerFib(ticker: string): Promise<FibRetraceResult | null> {
  const bars = await fetch5mBars(ticker);
  if (!bars || bars.length < LOOKBACK_BARS + 5) return null;

  const { direction: trendDir, swingHigh, swingLow } = detectTrend(bars);
  if (trendDir === 'ambiguous') return null;

  const swingRange = swingHigh - swingLow;
  if (swingRange <= 0) return null;

  // Compute fib levels
  const fib236 = computeFibLevel(swingHigh, swingLow, 0.236, trendDir);
  const fib382 = computeFibLevel(swingHigh, swingLow, 0.382, trendDir);

  // ATR for zone tolerance
  const atr = computeATR(
    bars.map(b => ({ high: b.high, low: b.low, close: b.close })),
    14,
  );
  const atrVal = isNaN(atr) ? swingRange * 0.1 : atr;
  const zoneTolerance = Math.max(0.001 * fib236, 0.05 * atrVal);

  // Check last completed bar for 0.236 rejection
  const last = bars[bars.length - 1];

  let wickedInto = false;
  let closedOnTrendSide = false;

  if (trendDir === 'up') {
    // Uptrend: price dips to fib 236 (support), wicks in, closes back above
    // fib236 is below current price in an uptrend retracement
    wickedInto = last.low <= fib236 + zoneTolerance && last.low >= fib236 - zoneTolerance;
    closedOnTrendSide = last.close > fib236;
  } else {
    // Downtrend: price bounces to fib 236 (resistance), wicks in, closes back below
    // fib236 is above current price in a downtrend retracement
    wickedInto = last.high >= fib236 - zoneTolerance && last.high <= fib236 + zoneTolerance;
    closedOnTrendSide = last.close < fib236;
  }

  if (!wickedInto || !closedOnTrendSide) return null;

  // Determine trade direction and levels
  const isLong = trendDir === 'up';
  const signal: 'BUY' | 'SELL' = isLong ? 'BUY' : 'SELL';
  const entry = last.close;

  // Stop: beyond 0.382 level - buffer
  const buffer = Math.max(0.001 * entry, 0.3 * atrVal);
  let stop: number;
  if (isLong) {
    stop = fib382 - buffer;  // stop below 0.382 for longs
  } else {
    stop = fib382 + buffer;  // stop above 0.382 for shorts
  }

  // Target: pre-market high (long) or pre-market low (short)
  const sessionLevels = await fetchSessionLevels(ticker);
  let target: number;
  if (isLong) {
    const pmh = sessionLevels.preMarketHigh;
    target = (pmh && pmh > entry) ? pmh : entry + 1.5 * Math.abs(entry - stop);
  } else {
    const pml = sessionLevels.preMarketLow;
    target = (pml && pml < entry) ? pml : entry - 1.5 * Math.abs(entry - stop);
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return null;
  const rr = reward / risk;

  // Confidence scoring
  let confidence = 6;

  // +1 for clear trend (strong HL or LH ratio)
  const recent = bars.slice(-LOOKBACK_BARS);
  let trendStrength = 0;
  for (let i = 1; i < recent.length; i++) {
    if (isLong && recent[i].low > recent[i - 1].low) trendStrength++;
    if (!isLong && recent[i].high < recent[i - 1].high) trendStrength++;
  }
  if (trendStrength / (recent.length - 1) >= 0.6) confidence++;

  // +1 for volume on rejection bar (above average of recent bars)
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
  if (last.volume > avgVol * 1.2) confidence++;

  // +1 for R:R >= 2
  if (rr >= 2.0) confidence++;

  // +1 for PMH/PML alignment
  if (isLong && sessionLevels.preMarketHigh && sessionLevels.preMarketHigh > entry) confidence++;
  if (!isLong && sessionLevels.preMarketLow && sessionLevels.preMarketLow < entry) confidence++;

  if (confidence < MIN_CONFIDENCE) return null;

  return {
    ticker,
    signal,
    direction: isLong ? 'long' : 'short',
    entry: parseFloat(entry.toFixed(2)),
    stop: parseFloat(stop.toFixed(2)),
    target: parseFloat(target.toFixed(2)),
    confidence,
    riskReward: `${rr.toFixed(1)}:1`,
    trendDirection: trendDir,
    swingHigh: parseFloat(swingHigh.toFixed(2)),
    swingLow: parseFloat(swingLow.toFixed(2)),
    fib236Level: parseFloat(fib236.toFixed(2)),
    fib382Level: parseFloat(fib382.toFixed(2)),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the universe for Fibonacci 0.236 retracement rejection setups.
 * Called from the 15-min scheduler cycle.
 *
 * @param executeTrade  Callback that builds a TradeIdea and calls executeScannerTrade.
 */
export async function checkFibRetraceSetups(
  executeTrade: (result: FibRetraceResult) => Promise<void>,
): Promise<void> {
  resetIfNewDay();

  const etNow = getEtNow();
  const etMinutes = etNow.getHours() * 60 + etNow.getMinutes();
  if (etMinutes < TIME_GATE_START_MINUTES || etMinutes > TIME_GATE_END_MINUTES) {
    return;
  }

  console.log(`${LOG_PREFIX} Scanning ${SCANNER_UNIVERSE.length} tickers for fib 0.236 rejections...`);

  let setupsFound = 0;
  let triggeredCount = 0;

  const BATCH = 5;
  for (let i = 0; i < SCANNER_UNIVERSE.length; i += BATCH) {
    const batch = SCANNER_UNIVERSE.slice(i, i + BATCH);

    const results = await Promise.all(
      batch.map(async (ticker) => {
        const state = _states.get(ticker);
        if (state?.phase === 'done' || state?.phase === 'triggered') return null;

        try {
          return await analyzeTickerFib(ticker);
        } catch (err) {
          console.warn(`${LOG_PREFIX} ${ticker}: error —`, err instanceof Error ? err.message : err);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      setupsFound++;

      const existing = _states.get(result.ticker);
      if (existing?.phase === 'done' || existing?.phase === 'triggered') continue;

      console.log(
        `${LOG_PREFIX} ${result.ticker}: FIB 0.236 REJECTION (${result.trendDirection} trend) — ` +
        `Swing H=$${result.swingHigh} L=$${result.swingLow} | ` +
        `Fib236=$${result.fib236Level} Fib382=$${result.fib382Level} | ` +
        `${result.signal} Entry=$${result.entry} Stop=$${result.stop} Target=$${result.target} ` +
        `Conf=${result.confidence} R:R=${result.riskReward}`,
      );

      _states.set(result.ticker, {
        phase: 'triggered',
        direction: result.direction,
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

    if (i + BATCH < SCANNER_UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (setupsFound > 0 || triggeredCount > 0) {
    console.log(`${LOG_PREFIX} Cycle complete: ${setupsFound} setup(s) found, ${triggeredCount} triggered`);
  }
}
