/**
 * Penny Stock Momentum Scanner — Ross Cameron's mechanical rules.
 *
 * Stock selection: $2-$20, float <10M, 25%+ daily gain, 5x relative volume, news catalyst.
 * Entry: first green candle making new high after pullback, MACD + volume confirm, R:R >= 2:1.
 * Exit: MACD bearish cross, 9 EMA break, VWAP break, high-volume red candle, topping tail.
 * Risk: half-size first trade, full after winner, 3 consecutive losses = done for day.
 *
 * Runs as a local polling loop during 7:00-10:00 AM ET.
 * Writes candidates to trade_scans (id: 'penny_trades') for UI visibility.
 */

import type { AutoTraderConfig } from '../../../shared/config-defaults.js';

// ── Types ────────────────────────────────────────────────

export interface PennyCandidate {
  ticker: string;
  price: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  relativeVolume: number;
  float: number | null;
  hasCatalyst: boolean;
  catalystHeadline: string | null;
  rank: number;
  discoveredAt: number;
}

export interface PennySessionState {
  date: string;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  totalTrades: number;
  lastTradeWon: boolean | null;
  dailyPnl: number;
  peakDailyPnl: number;
  done: boolean;
  doneReason: string | null;
}

interface PennyEntrySignal {
  ticker: string;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  riskReward: number;
  pullbackNumber: number;
  macdHistogram: number;
  greenVolume: number;
  redAvgVolume: number;
}

// ── Constants ────────────────────────────────────────────

import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';

// Used by fetch1mCandles (Yahoo v8/chart — stable endpoint, no auth needed)
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};
const TIMEOUT_MS = 12_000;

const PRICE_MIN = 2;
const PRICE_MAX = 20;
const MIN_CHANGE_PCT = 25;
const MIN_VOLUME = 500_000;
const MIN_RELATIVE_VOLUME = 5;
const MAX_FLOAT_MILLIONS = 10;
const MIN_RR = 2.0;
const MAX_PULLBACKS = 2;

// ── Finnhub fetch alias ──────────────────────────────────

const fetchFinnhub = finnhubFetch;

// ── Session State ────────────────────────────────────────

let _session: PennySessionState = makeEmptySession();

function makeEmptySession(): PennySessionState {
  return {
    date: getETDateString(),
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    totalTrades: 0,
    lastTradeWon: null,
    dailyPnl: 0,
    peakDailyPnl: 0,
    done: false,
    doneReason: null,
  };
}

function getETDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function getPennySessionState(): PennySessionState {
  const today = getETDateString();
  if (_session.date !== today) _session = makeEmptySession();
  return _session;
}

export function resetPennySession(): void {
  _session = makeEmptySession();
}

export function recordPennyTradeResult(pnl: number, config: AutoTraderConfig): void {
  const session = getPennySessionState();
  session.totalTrades++;
  session.dailyPnl += pnl;
  if (session.dailyPnl > session.peakDailyPnl) session.peakDailyPnl = session.dailyPnl;

  if (pnl > 0) {
    session.wins++;
    session.consecutiveLosses = 0;
    session.lastTradeWon = true;
  } else {
    session.losses++;
    session.consecutiveLosses++;
    session.lastTradeWon = false;
  }

  // Guard rails
  if (session.consecutiveLosses >= 3) {
    session.done = true;
    session.doneReason = '3 consecutive losses';
  }
  if (session.dailyPnl <= -(config.pennyMaxDailyLoss || 200)) {
    session.done = true;
    session.doneReason = `max daily loss hit ($${config.pennyMaxDailyLoss || 200})`;
  }
  if (session.peakDailyPnl > 50 && session.dailyPnl < session.peakDailyPnl * 0.5) {
    session.done = true;
    session.doneReason = 'gave back 50% of daily profit';
  }
  if (session.totalTrades >= (config.pennyMaxDailyTrades || 10)) {
    session.done = true;
    session.doneReason = `max daily trades hit (${config.pennyMaxDailyTrades || 10})`;
  }
}

// ── Position Sizing ──────────────────────────────────────

export function pennyPositionSize(config: AutoTraderConfig): number {
  const session = getPennySessionState();
  const fullSize = config.pennyPositionSize || 200;
  if (session.totalTrades === 0) return fullSize * 0.5;
  if (session.lastTradeWon) return fullSize;
  return fullSize * 0.5;
}

// ── Discovery: IB Scanner + Finnhub Enrichment ───────────

export interface IBGainerResult {
  ticker: string;
  distancePct: number | null;
}

/**
 * Discover penny gapper candidates.
 * Accepts pre-fetched IB scanner results (passed from scheduler which has the IB connection).
 * Falls back to an empty list if not provided — callers should always pass ibGainers.
 */
export async function runPennyDiscovery(ibGainers: IBGainerResult[] = []): Promise<PennyCandidate[]> {
  if (!ibGainers.length) {
    console.log('[PennyScanner] No IB gainers provided — nothing to enrich');
    return [];
  }

  // Cap enrichment at 12 tickers to stay within Finnhub's 55/min rate limit.
  // Each ticker uses ~2 Finnhub calls (quote + metric); 12 × 2 = 24 calls leaving
  // headroom for the rest of the scheduler's Finnhub usage.
  const enrichBatch = ibGainers.slice(0, 12);
  console.log(`[PennyScanner] Enriching ${enrichBatch.length} IB gainer(s) via Finnhub`);

  // Enrich each IB-scanned ticker with Finnhub quote + single metric call (covers
  // both RVOL avg-volume and float, avoiding a duplicate network call).
  const candidates: PennyCandidate[] = [];
  for (const g of enrichBatch) {
    const ticker = g.ticker;

    // ── 1. Finnhub quote (price, volume, prev close) ──────────────────────────
    const quote = await fetchFinnhub<{ c?: number; v?: number; pc?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`
    );
    if (!quote) {
      console.log(`[PennyScanner]   SKIP ${ticker} — no Finnhub quote`);
      continue;
    }

    const price = quote.c ?? 0;
    const volume = quote.v ?? 0;
    const prevClose = quote.pc ?? price;

    // IB's TOP_PERC_GAIN distancePct = today's % gain from prior close — purpose-built
    // for this calculation. Finnhub's pc field is often stale for OTC/nano-caps: the
    // stock might be up 40% per IB but Finnhub's pc equals today's open, giving ~0%
    // change. The ?? fallback only triggers when finnhubChangePct is null (prevClose=0),
    // so it never fires in practice — Finnhub always returns a non-zero pc.
    //
    // Fix: trust IB distancePct as primary; only override with Finnhub when Finnhub
    // shows a meaningfully different (and plausible) result (>1%) — e.g. for
    // exchange-listed stocks where Finnhub's pc is reliable.
    const finnhubChangePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
    const changePct = (finnhubChangePct != null && finnhubChangePct > 1)
      ? finnhubChangePct
      : (g.distancePct ?? finnhubChangePct ?? 0);

    // ── 2. Price / change / volume gate ──────────────────────────────────────
    if (price < PRICE_MIN || price > PRICE_MAX) {
      console.log(`[PennyScanner]   SKIP ${ticker} — price $${price.toFixed(2)} outside [$${PRICE_MIN}–$${PRICE_MAX}]`);
      continue;
    }
    if (changePct < MIN_CHANGE_PCT) {
      console.log(`[PennyScanner]   SKIP ${ticker} — changePct ${changePct.toFixed(1)}% < ${MIN_CHANGE_PCT}% (IB dist: ${g.distancePct?.toFixed(0) ?? 'n/a'}%)`);
      continue;
    }
    if (volume < MIN_VOLUME) {
      console.log(`[PennyScanner]   SKIP ${ticker} — volume ${volume.toLocaleString()} < ${MIN_VOLUME.toLocaleString()}`);
      continue;
    }

    // ── 3. Single Finnhub metric call (avg vol + float) ──────────────────────
    // Reuse one response for both RVOL and float; avoids a duplicate API call.
    const metric = await fetchFinnhub<{ metric?: { '10DayAverageTradingVolume'?: number; shareFloat?: number } }>(
      `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`
    );
    const rawAvgVol = metric?.metric?.['10DayAverageTradingVolume'];
    const avgVolume  = rawAvgVol != null ? rawAvgVol * 1_000_000 : 0;

    // RVOL: for OTC/nano-caps Finnhub often has no metric data → avgVolume = 0.
    // Fallback: raw volume ≥ 1.5M on a sub-$20 stock = elevated enough to qualify.
    let relativeVolume: number;
    if (avgVolume > 0) {
      relativeVolume = volume / avgVolume;
    } else {
      relativeVolume = volume >= 1_500_000 ? MIN_RELATIVE_VOLUME + 1 : volume / 300_000;
      console.log(`[PennyScanner]   ${ticker} — no Finnhub avg vol; synthetic RVOL ${relativeVolume.toFixed(1)}x (vol ${volume.toLocaleString()})`);
    }
    if (relativeVolume < MIN_RELATIVE_VOLUME) {
      console.log(`[PennyScanner]   SKIP ${ticker} — RVOL ${relativeVolume.toFixed(1)}x < ${MIN_RELATIVE_VOLUME}x`);
      continue;
    }

    // Float from same metric response (no extra call needed).
    // When shareFloat is null (common for OTC), proxy via avg daily volume:
    // a stock with 10M+ avg daily volume cannot have a <10M share float — that
    // would imply 100%+ of float trading every single day, which is impossible.
    // This catches large-float stocks (AMC, SPCE) that slip through when Finnhub
    // has no float data.
    const floatShares = metric?.metric?.shareFloat ?? null;
    const inferredLargeFloat = floatShares == null && avgVolume > 10_000_000;
    if (inferredLargeFloat) {
      console.log(`[PennyScanner]   SKIP ${ticker} — float unknown but avg vol ${(avgVolume / 1_000_000).toFixed(1)}M/day implies large float`);
      continue;
    }
    if (floatShares != null && floatShares > MAX_FLOAT_MILLIONS) {
      console.log(`[PennyScanner]   SKIP ${ticker} — float ${floatShares.toFixed(1)}M > ${MAX_FLOAT_MILLIONS}M`);
      continue;
    }

    // ── 4. News catalyst ──────────────────────────────────────────────────────
    const { hasCatalyst, headline } = await checkNewsCatalyst(ticker);

    console.log(`[PennyScanner]   PASS ${ticker} — $${price.toFixed(2)} +${changePct.toFixed(0)}% vol ${volume.toLocaleString()} RVOL ${relativeVolume.toFixed(1)}x float ${floatShares?.toFixed(1) ?? 'unknown'}M catalyst:${hasCatalyst}`);

    candidates.push({
      ticker,
      price,
      changePct,
      volume,
      avgVolume,
      relativeVolume,
      float: floatShares,
      hasCatalyst,
      catalystHeadline: headline,
      rank: 0,
      discoveredAt: Date.now(),
    });
  }

  // Rank by % change, take top 3
  candidates.sort((a, b) => b.changePct - a.changePct);
  candidates.forEach((c, i) => { c.rank = i + 1; });
  console.log(`[PennyScanner] ${candidates.length} candidate(s) passed all filters`);
  return candidates.slice(0, 3);
}


async function checkNewsCatalyst(ticker: string): Promise<{ hasCatalyst: boolean; headline: string | null }> {
  if (!FINNHUB_KEY) return { hasCatalyst: false, headline: null };
  const today = getETDateString();
  const news = await fetchFinnhub<Array<{ headline?: string; datetime?: number }>>(
    `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${today}&to=${today}&token=${FINNHUB_KEY}`
  );
  if (!news?.length) return { hasCatalyst: false, headline: null };

  // Only count news from the last 2 hours
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const recent = news.filter(n => (n.datetime ?? 0) * 1000 > twoHoursAgo);
  return {
    hasCatalyst: recent.length > 0,
    headline: recent[0]?.headline ?? news[0]?.headline ?? null,
  };
}

// ── Entry Signal: Pullback Pattern on 1-min Candles ──────

interface IntradayBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function fetch1mCandles(ticker: string): Promise<IntradayBar[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m&includePrePost=false`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json() as Record<string, unknown>;
    const result = (data?.chart as Record<string, unknown>)?.result as Record<string, unknown>[] | undefined;
    if (!result?.[0]) return [];

    const r = result[0];
    const timestamps = r.timestamp as number[] | undefined;
    if (!timestamps?.length) return [];

    const q = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] ?? {};
    const opens   = (q.open   as (number | null)[]) ?? [];
    const highs   = (q.high   as (number | null)[]) ?? [];
    const lows    = (q.low    as (number | null)[]) ?? [];
    const closes  = (q.close  as (number | null)[]) ?? [];
    const volumes = (q.volume as (number | null)[]) ?? [];

    const bars: IntradayBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      bars.push({
        t: timestamps[i],
        o: opens[i] ?? c,
        h: highs[i] ?? c,
        l: lows[i] ?? c,
        c,
        v: volumes[i] ?? 0,
      });
    }
    return bars;
  } catch {
    return [];
  }
}

function computeSimpleMACD(bars: IntradayBar[]): { histogram: number; signal: number } | null {
  if (bars.length < 26) return null;
  const closes = bars.map(b => b.c);
  const ema12 = emaCalc(closes, 12);
  const ema26 = emaCalc(closes, 26);
  if (ema12 == null || ema26 == null) return null;

  const macdLine = ema12 - ema26;
  // Approximate signal line from recent MACD values
  const recentMacd: number[] = [];
  for (let i = Math.max(0, closes.length - 9); i < closes.length; i++) {
    const e12 = emaCalc(closes.slice(0, i + 1), 12);
    const e26 = emaCalc(closes.slice(0, i + 1), 26);
    if (e12 != null && e26 != null) recentMacd.push(e12 - e26);
  }
  const signalLine = recentMacd.length >= 9 ? emaCalc(recentMacd, 9) ?? macdLine : macdLine;
  return { histogram: macdLine - signalLine, signal: signalLine };
}

function emaCalc(data: number[], period: number): number | null {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += data[i];
  prev /= period;
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
  }
  return prev;
}

function ema9Value(bars: IntradayBar[]): number | null {
  if (bars.length < 9) return null;
  return emaCalc(bars.map(b => b.c), 9);
}

function computeVWAP(bars: IntradayBar[]): number | null {
  if (!bars.length) return null;
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * b.v;
    cumV += b.v;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

/**
 * Detect pullback entry pattern on 1-min candles.
 * Finds the Nth pullback (sequence of red candles → green candle making new high).
 */
function findPullbackEntries(bars: IntradayBar[]): PennyEntrySignal[] {
  if (bars.length < 10) return [];

  const entries: PennyEntrySignal[] = [];
  let pullbackCount = 0;
  let i = 5; // skip first few bars to let price establish

  while (i < bars.length - 1) {
    // Look for red candle(s) = pullback
    const pullbackStart = i;
    let redMaxVol = 0;
    let pullbackLow = Infinity;

    while (i < bars.length && bars[i].c < bars[i].o) {
      redMaxVol = Math.max(redMaxVol, bars[i].v);
      pullbackLow = Math.min(pullbackLow, bars[i].l);
      i++;
    }

    // Need at least 1 red candle for a pullback
    if (i === pullbackStart) { i++; continue; }
    if (i >= bars.length) break;

    // Current bar should be green: close > open
    const greenBar = bars[i];
    if (greenBar.c <= greenBar.o) { i++; continue; }

    // Green candle must make new high vs prior candle's high
    const priorHigh = bars[i - 1].h;
    if (greenBar.h <= priorHigh) { i++; continue; }

    // Volume confirmation: green candle volume > avg red candle volume
    const redCount = i - pullbackStart;
    const redAvgVol = redCount > 0 ? redMaxVol / redCount * redCount : 0;
    // Simplified: green volume must exceed max red volume
    if (greenBar.v <= redMaxVol * 0.8) { i++; continue; }

    pullbackCount++;

    // High of day up to this point
    let hod = 0;
    for (let j = 0; j <= i; j++) hod = Math.max(hod, bars[j].h);

    const entry = greenBar.c;
    const stop = pullbackLow;
    const target = hod;
    const risk = entry - stop;
    const reward = target - entry;

    if (risk > 0 && reward / risk >= MIN_RR) {
      entries.push({
        ticker: '',
        entryPrice: entry,
        stopLoss: stop,
        targetPrice: target,
        riskReward: reward / risk,
        pullbackNumber: pullbackCount,
        macdHistogram: 0,
        greenVolume: greenBar.v,
        redAvgVolume: redAvgVol,
      });
    }

    i++;
  }

  return entries;
}

export async function checkPennyEntry(candidate: PennyCandidate): Promise<PennyEntrySignal | null> {
  const bars = await fetch1mCandles(candidate.ticker);
  if (bars.length < 30) return null;

  // MACD must be positive
  const macd = computeSimpleMACD(bars);
  if (!macd || macd.histogram <= 0) return null;

  // Find pullback entries
  const entries = findPullbackEntries(bars);

  // Only trade 1st and 2nd pullbacks
  const eligible = entries.filter(e => e.pullbackNumber <= MAX_PULLBACKS);
  if (!eligible.length) return null;

  // Take the latest eligible entry
  const signal = eligible[eligible.length - 1];
  signal.ticker = candidate.ticker;
  signal.macdHistogram = macd.histogram;
  return signal;
}

// ── Exit Signal Monitoring ───────────────────────────────

export interface PennyExitSignal {
  ticker: string;
  reasons: string[];
}

export async function checkPennyExit(ticker: string, entryPrice: number): Promise<PennyExitSignal | null> {
  const bars = await fetch1mCandles(ticker);
  if (bars.length < 10) return null;

  const reasons: string[] = [];
  const lastBar = bars[bars.length - 1];
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;

  // 1. MACD crossover to negative
  const macd = computeSimpleMACD(bars);
  if (macd && macd.histogram < 0) {
    reasons.push('MACD crossed negative');
  }

  // 2. High-volume red candle
  if (lastBar.c < lastBar.o) {
    const avgVol = bars.slice(-10).reduce((s, b) => s + b.v, 0) / Math.min(bars.length, 10);
    if (lastBar.v > avgVol * 2) {
      reasons.push('High-volume red candle');
    }
  }

  // 3. Price below 9 EMA
  const ema9 = ema9Value(bars);
  if (ema9 != null && lastBar.c < ema9) {
    reasons.push('Below 9 EMA');
  }

  // 4. Price below VWAP
  const vwap = computeVWAP(bars);
  if (vwap != null && lastBar.c < vwap) {
    reasons.push('Below VWAP');
  }

  // 5. Topping tail / doji
  if (prevBar) {
    const body = Math.abs(lastBar.c - lastBar.o);
    const upperWick = lastBar.h - Math.max(lastBar.c, lastBar.o);
    if (body > 0 && upperWick > body * 2) {
      reasons.push('Topping tail');
    }
    if (body < (lastBar.h - lastBar.l) * 0.1 && (lastBar.h - lastBar.l) > 0) {
      reasons.push('Doji candle');
    }
  }

  return reasons.length > 0 ? { ticker, reasons } : null;
}

// ── Helpers for scheduler integration ────────────────────

export function isPennySessionDone(): boolean {
  return getPennySessionState().done;
}

export function getPennySessionSummary(): string {
  const s = getPennySessionState();
  const parts = [`W:${s.wins} L:${s.losses} PnL:$${s.dailyPnl.toFixed(0)}`];
  if (s.done) parts.push(`(done: ${s.doneReason})`);
  return parts.join(' ');
}
