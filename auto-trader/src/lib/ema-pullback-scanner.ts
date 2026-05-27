/**
 * EMA 9/21 Pullback Scanner
 *
 * Detects intraday long setups where a trending stock pulls back to the 9 EMA
 * and closes back above it (bullish resumption). Long-only.
 *
 * Setup conditions (all must pass):
 *   1. Regime:  EMA9 > EMA21, separation >= 0.3% of price
 *   2. Trend:   ADX >= 25 (trending, not ranging)
 *   3. Chop:    <= 3 crossings of 9/21 in last 20 bars (not whipping)
 *   4. Pullback: at least one of last 3 prior bars had low <= EMA9 (touched the level)
 *   5. Resume:  current bar closes > EMA9
 *
 * Stop:   below swing low of last 12 bars minus ATR buffer
 * Target: pre-market high if above entry, otherwise entry + 1.5 * risk
 *
 * Purely rule-based — no AI/Gemini calls. Runs on the 15-min scheduler cycle.
 * State machine per ticker: idle → triggered → done. Resets daily.
 * Time gate: 10:00 AM – 3:30 PM ET.
 */

import type { AutoTraderConfig } from '../../../shared/config-defaults.js';
import type { AccountType } from '../../../shared/trade-types.js';
import { computeEMA, computeADX, computeATR } from './intraday-indicators.js';
import { fetchSessionLevels } from './session-levels.js';

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[EMAPullback]';
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};
const TIMEOUT_MS = 12_000;

const MIN_CONFIDENCE = 7;
const TIME_GATE_START_MINUTES = 10 * 60;       // 10:00 AM ET
const TIME_GATE_END_MINUTES = 15 * 60 + 30;    // 3:30 PM ET

// Minimum EMA9/EMA21 separation as % of price to confirm trend (not tangled)
const MIN_EMA_SEPARATION_PCT = 0.003;

// ADX threshold for "trending" market
const ADX_TREND_THRESHOLD = 25;

// Chop filter: if 9/21 cross more than this many times in CHOP_LOOKBACK bars → skip
const MAX_CROSSINGS = 3;
const CHOP_LOOKBACK = 20;

// How many prior bars to look back for a pullback touch of EMA9
const PULLBACK_LOOKBACK = 3;

// Swing low lookback for stop placement
const SWING_LOW_LOOKBACK = 12;

// Universe: mega-cap + liquid ETFs + semiconductors (same base as other scanners + SNDK)
const SCANNER_UNIVERSE = [
  'TSLA', 'AMD', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL',
  'SPY', 'QQQ', 'IWM',
  'NFLX', 'COIN', 'MSTR', 'SMCI', 'ARM', 'AVGO', 'CRM', 'UBER',
  'MU', 'INTC', 'PYPL', 'SQ', 'SHOP', 'PLTR',
  'SNDK',
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

type Phase = 'idle' | 'triggered' | 'done';

interface TickerState {
  phase: Phase;
  triggeredAt: number;
}

export interface EmaPullbackResult {
  ticker: string;
  signal: 'BUY';
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  riskReward: string;
  ema9: number;
  ema21: number;
  adx: number;
}

// ── Module state (resets daily) ──────────────────────────────────────────────

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

// ── Yahoo Finance data fetcher ───────────────────────────────────────────────

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
    const q = result.indicators?.quote?.[0];
    if (!q || timestamps.length === 0) return null;

    const bars: Bar5m[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i];
      if (o == null || h == null || l == null || c == null || v == null) continue;
      if (c === 0) continue;
      bars.push({ ts: timestamps[i], open: o, high: h, low: l, close: c, volume: v });
    }

    if (bars.length === 0) return null;
    _barCache.set(key, { bars, fetchedAt: Date.now() });
    return bars;
  } catch {
    return null;
  }
}

// ── Chop detector ────────────────────────────────────────────────────────────

/**
 * Count how many times EMA9 and EMA21 cross in the last `lookback` bars.
 * A crossing is when the sign of (ema9 - ema21) flips between consecutive bars.
 */
function countEmaCrossings(ema9Series: number[], ema21Series: number[], lookback: number): number {
  const len = ema9Series.length;
  const start = Math.max(1, len - lookback);
  let crossings = 0;
  for (let i = start; i < len; i++) {
    const prevAbove = ema9Series[i - 1] > ema21Series[i - 1];
    const nowAbove = ema9Series[i] > ema21Series[i];
    if (prevAbove !== nowAbove) crossings++;
  }
  return crossings;
}

// ── Core analysis ────────────────────────────────────────────────────────────

async function analyzeTickerPullback(ticker: string): Promise<EmaPullbackResult | null> {
  const bars = await fetch5mBars(ticker);
  // Need enough bars for ADX(14) = 2*14+1 = 29, plus our lookbacks
  if (!bars || bars.length < 35) return null;

  const closes = bars.map(b => b.close);

  // Compute EMA series (oldest-first output matches bars order)
  const ema9Series = computeEMA(closes, 9);
  const ema21Series = computeEMA(closes, 21);

  const lastIdx = bars.length - 1;
  const ema9 = ema9Series[lastIdx];
  const ema21 = ema21Series[lastIdx];

  if (isNaN(ema9) || isNaN(ema21)) return null;

  // 1. Regime: EMA9 must be above EMA21 with meaningful separation
  if (ema9 <= ema21) return null;
  const separationPct = (ema9 - ema21) / bars[lastIdx].close;
  if (separationPct < MIN_EMA_SEPARATION_PCT) return null;

  // 2. ADX >= 25 (trending, not choppy)
  const ohlcBars = bars.map(b => ({ high: b.high, low: b.low, close: b.close }));
  const adx = computeADX(ohlcBars, 14);
  if (isNaN(adx) || adx < ADX_TREND_THRESHOLD) return null;

  // 3. Chop filter: <= MAX_CROSSINGS of 9/21 in last CHOP_LOOKBACK bars
  const crossings = countEmaCrossings(ema9Series, ema21Series, CHOP_LOOKBACK);
  if (crossings > MAX_CROSSINGS) return null;

  // 4. Pullback: one of the last PULLBACK_LOOKBACK prior bars touched EMA9 from above
  // (low dipped to or below EMA9 while the bar before that was above)
  const currentBar = bars[lastIdx];
  let hadPullback = false;
  for (let i = lastIdx - PULLBACK_LOOKBACK; i < lastIdx; i++) {
    if (i < 0) continue;
    const barEma9 = ema9Series[i];
    if (isNaN(barEma9)) continue;
    if (bars[i].low <= barEma9) {
      hadPullback = true;
      break;
    }
  }
  if (!hadPullback) return null;

  // 5. Resumption: current bar closes above EMA9
  if (currentBar.close <= ema9) return null;

  // ── Stop: swing low of last SWING_LOW_LOOKBACK bars minus ATR buffer ──────
  const atr = computeATR(ohlcBars, 14);
  const atrVal = isNaN(atr) ? currentBar.close * 0.003 : atr;

  const recentBars = bars.slice(-SWING_LOW_LOOKBACK);
  const swingLow = Math.min(...recentBars.map(b => b.low));
  const buffer = Math.max(0.001 * currentBar.close, 0.3 * atrVal);
  const stop = swingLow - buffer;

  const entry = currentBar.close;
  const risk = entry - stop;
  if (risk <= 0) return null;

  // ── Target: pre-market high if above entry, else 1.5x risk ───────────────
  const sessionLevels = await fetchSessionLevels(ticker);
  const pmh = sessionLevels.preMarketHigh;
  const target = pmh && pmh > entry ? pmh : entry + 1.5 * risk;

  const reward = target - entry;
  const rr = reward / risk;
  if (rr < 1.2) return null;

  // ── Confidence scoring ────────────────────────────────────────────────────
  let confidence = 6;

  // Strong EMA separation (> 0.5% of price) = clean trend
  if (separationPct >= 0.005) confidence++;

  // High ADX = very strong trend
  if (adx >= 35) confidence++;

  // Close well above EMA9 (at least 0.1% above) = momentum on resumption bar
  if ((currentBar.close - ema9) / ema9 >= 0.001) confidence++;

  // Good R:R
  if (rr >= 2.0) confidence++;

  // PMH above entry = positive morning context
  if (pmh && pmh > entry) confidence++;

  if (confidence < MIN_CONFIDENCE) return null;

  return {
    ticker,
    signal: 'BUY',
    entry: parseFloat(entry.toFixed(2)),
    stop: parseFloat(stop.toFixed(2)),
    target: parseFloat(target.toFixed(2)),
    confidence,
    riskReward: `${rr.toFixed(1)}:1`,
    ema9: parseFloat(ema9.toFixed(2)),
    ema21: parseFloat(ema21.toFixed(2)),
    adx: parseFloat(adx.toFixed(1)),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the universe for 9/21 EMA pullback setups (long-only).
 * Called from the 15-min scheduler cycle.
 *
 * @param executeTrade  Callback that builds a TradeIdea and calls executeScannerTrade.
 */
export async function checkEmaPullbackSetups(
  executeTrade: (result: EmaPullbackResult) => Promise<void>,
): Promise<void> {
  resetIfNewDay();

  const etNow = getEtNow();
  const etMinutes = etNow.getHours() * 60 + etNow.getMinutes();
  if (etMinutes < TIME_GATE_START_MINUTES || etMinutes > TIME_GATE_END_MINUTES) {
    return;
  }

  console.log(`${LOG_PREFIX} Scanning ${SCANNER_UNIVERSE.length} tickers for 9/21 EMA pullbacks...`);

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
          return await analyzeTickerPullback(ticker);
        } catch (err) {
          console.warn(`${LOG_PREFIX} ${ticker}: error —`, err instanceof Error ? err.message : err);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      setupsFound++;

      const state = _states.get(result.ticker);
      if (state?.phase === 'triggered') continue;

      _states.set(result.ticker, { phase: 'triggered', triggeredAt: Date.now() });
      triggeredCount++;

      try {
        await executeTrade(result);
        _states.set(result.ticker, { phase: 'done', triggeredAt: Date.now() });
      } catch (err) {
        // Reset to idle so the next cycle can retry
        _states.set(result.ticker, { phase: 'idle', triggeredAt: 0 });
        console.error(`${LOG_PREFIX} ${result.ticker}: executeTrade failed —`, err instanceof Error ? err.message : err);
      }
    }

    // Small delay between batches to be polite to Yahoo
    if (i + BATCH < SCANNER_UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`${LOG_PREFIX} Scan complete: ${setupsFound} setups found, ${triggeredCount} triggered`);
}
