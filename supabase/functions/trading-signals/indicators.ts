// Technical Indicator Engine — pure math, zero dependencies.
// All functions accept OHLCV arrays (newest-first, matching Twelve Data order)
// and return computed values.

export interface OHLCV {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ── Helpers ──────────────────────────────────────────────

/** Reverse to oldest-first for rolling computations, then reverse result back. */
function oldestFirst(data: OHLCV[]): OHLCV[] {
  return [...data].reverse();
}

// ── Simple Moving Average ────────────────────────────────

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  return sum / period;
}

// ── Exponential Moving Average ───────────────────────────

export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let prev = 0;
  for (let i = closes.length - period; i < closes.length; i++) prev += closes[i];
  prev /= period;

  // Walk forward from oldest
  for (let i = closes.length - period + 1; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
  }
  // Wait — the closes coming in are oldest-first for this helper,
  // let me re-think the interface.
  // Actually, let's keep it simple: accept oldest-first arrays for internal helpers.
  // The public API will handle reversals.
  return prev;
}

/** EMA over oldest-first closes, returns final value. */
function emaOldest(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed: SMA of first `period` values
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
  }
  return prev;
}

/** Full EMA series (oldest-first in, oldest-first out). */
function emaSeries(closes: number[], period: number): number[] {
  const result: number[] = [];
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  // Fill the first `period-1` slots with NaN (not enough data)
  for (let i = 0; i < period - 1; i++) result.push(NaN);
  result.push(prev);
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ── RSI (Wilder smoothing) ──────────────────────────────

export function computeRSI(data: OHLCV[], period = 14): number | null {
  const bars = oldestFirst(data);
  if (bars.length < period + 1) return null;

  const closes = bars.map(b => b.c);
  let avgGain = 0;
  let avgLoss = 0;

  // Initial average: first `period` changes
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── MACD (12, 26, 9) ───────────────────────────────────

export interface MACDResult {
  value: number;
  signal: number;
  histogram: number;
}

export function computeMACD(
  data: OHLCV[],
  fast = 12,
  slow = 26,
  sig = 9
): MACDResult | null {
  const bars = oldestFirst(data);
  if (bars.length < slow + sig) return null;

  const closes = bars.map(b => b.c);

  // Compute full EMA series for fast and slow
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);

  // MACD line = fast EMA - slow EMA (starting from index slow-1)
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(fastEma[i]) || isNaN(slowEma[i])) {
      macdLine.push(NaN);
    } else {
      macdLine.push(fastEma[i] - slowEma[i]);
    }
  }

  // Signal line = 9-EMA of MACD line (skip NaN prefix)
  const validMacd = macdLine.filter(v => !isNaN(v));
  if (validMacd.length < sig) return null;

  const signalVal = emaOldest(validMacd, sig);
  if (signalVal === null) return null;

  const macdVal = validMacd[validMacd.length - 1];
  return {
    value: round(macdVal),
    signal: round(signalVal),
    histogram: round(macdVal - signalVal),
  };
}

// ── ATR (Average True Range) ────────────────────────────

export function computeATR(data: OHLCV[], period = 14): number | null {
  const bars = oldestFirst(data);
  if (bars.length < period + 1) return null;

  // True Range series
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trValues.push(tr);
  }

  // Initial ATR = simple average of first `period` TR values
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trValues[i];
  atr /= period;

  // Wilder smoothing
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return atr;
}

// ── ADX (Average Directional Index) ─────────────────────

export function computeADX(data: OHLCV[], period = 14): number | null {
  const bars = oldestFirst(data);
  if (bars.length < 2 * period + 1) return null;

  const trValues: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trValues.push(tr);

    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing for TR, +DM, -DM
  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trValues[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dxValues: number[] = [];

  for (let i = period; i < trValues.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trValues[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return null;

  // First ADX = simple average of first `period` DX values
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxValues[i];
  adx /= period;

  // Wilder smoothing for ADX
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

// ── EMA / SMA convenience wrappers (newest-first input) ─

export function computeEMA(data: OHLCV[], period: number): number | null {
  const bars = oldestFirst(data);
  const closes = bars.map(b => b.c);
  return emaOldest(closes, period);
}

export function computeSMA(data: OHLCV[], period: number): number | null {
  const bars = oldestFirst(data);
  const closes = bars.map(b => b.c);
  return sma(closes.slice(-period), period);
}

// ── EMA/SMA Crossover Detection ─────────────────────────

export type CrossoverState = 'bullish_cross' | 'bearish_cross' | 'above' | 'below' | null;

/**
 * Detect EMA(20) vs SMA(50) crossover.
 * Computes current and previous-bar values to detect if a crossover just happened.
 */
export function detectEMASMACrossover(data: OHLCV[]): CrossoverState {
  if (data.length < 52) return null; // need at least 51 bars + 1 for previous

  // Current bar values
  const ema20Now = computeEMA(data, 20);
  const sma50Now = computeSMA(data, 50);
  if (ema20Now === null || sma50Now === null) return null;

  // Previous bar values (remove newest bar)
  const prevData = data.slice(1);
  const ema20Prev = computeEMA(prevData, 20);
  const sma50Prev = computeSMA(prevData, 50);
  if (ema20Prev === null || sma50Prev === null) {
    return ema20Now > sma50Now ? 'above' : 'below';
  }

  const nowAbove = ema20Now > sma50Now;
  const prevAbove = ema20Prev > sma50Prev;

  if (nowAbove && !prevAbove) return 'bullish_cross'; // just crossed above
  if (!nowAbove && prevAbove) return 'bearish_cross';  // just crossed below
  return nowAbove ? 'above' : 'below';
}

// ── Trend Classification ────────────────────────────────

export type TrendLabel = 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend';

/**
 * Classify the trend based on price vs MA relationships.
 * - Price above both SMA(50) and SMA(200) = uptrend
 * - Price above SMA(50) and SMA(200), with 50 > 200 = strong uptrend
 * - Price below both = downtrend
 * - Mixed = sideways
 */
export function classifyTrend(currentPrice: number, sma50: number | null, sma200: number | null): TrendLabel {
  if (sma50 === null && sma200 === null) return 'sideways';

  const aboveSma50 = sma50 !== null && currentPrice > sma50;
  const aboveSma200 = sma200 !== null && currentPrice > sma200;
  const sma50AboveSma200 = sma50 !== null && sma200 !== null && sma50 > sma200;

  if (aboveSma50 && aboveSma200 && sma50AboveSma200) return 'strong_uptrend';
  if (aboveSma50 && aboveSma200) return 'uptrend';
  if (!aboveSma50 && !aboveSma200 && sma50 !== null && sma200 !== null && sma50 < sma200) return 'strong_downtrend';
  if (!aboveSma50 && !aboveSma200) return 'downtrend';
  return 'sideways';
}

// ── Volume Ratio ────────────────────────────────────────

export function computeVolumeRatio(data: OHLCV[], period = 20): { current: number; average: number; ratio: number } | null {
  if (data.length < period + 1) return null;
  // data[0] is newest
  const current = data[0].v;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += data[i].v;
  const average = sum / period;
  if (average === 0) return { current, average, ratio: 0 };
  return { current, average, ratio: round(current / average) };
}

// ── Support & Resistance (swing high/low detection) ─────

export interface SupportResistance {
  support: number[];
  resistance: number[];
}

export function computeSupportResistance(data: OHLCV[], lookback = 5, count = 2): SupportResistance {
  // data is newest-first; we'll scan for local swing highs/lows
  const bars = oldestFirst(data);
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
    }
    if (isHigh) swingHighs.push(bars[i].h);
    if (isLow) swingLows.push(bars[i].l);
  }

  const currentPrice = bars[bars.length - 1].c;

  // Resistance = swing highs above current price, nearest first
  const resistance = swingHighs
    .filter(p => p > currentPrice)
    .sort((a, b) => a - b)
    .slice(0, count)
    .map(round);

  // Support = swing lows below current price, nearest first
  const support = swingLows
    .filter(p => p < currentPrice)
    .sort((a, b) => b - a)
    .slice(0, count)
    .map(round);

  return { support, resistance };
}

// ── Gap Detection ───────────────────────────────────────

export interface GapInfo {
  type: 'up' | 'down';
  gapStart: number;  // bottom of gap (for up gaps: previous high)
  gapEnd: number;    // top of gap (for up gaps: current low)
  filled: boolean;
}

/**
 * Detect price gaps in candle data. Data is newest-first.
 * A gap up = bar's low > previous bar's high (price jumped over a range).
 * A gap down = bar's high < previous bar's low.
 * Then check if any subsequent bar filled the gap.
 * Returns only recent gaps (last 60 bars) to keep it relevant.
 */
export function detectGaps(data: OHLCV[], maxBars = 60): GapInfo[] {
  if (data.length < 3) return [];

  const bars = oldestFirst(data);
  const scanLen = Math.min(bars.length, maxBars);
  const startIdx = bars.length - scanLen;
  const gaps: { type: 'up' | 'down'; gapStart: number; gapEnd: number; barIdx: number }[] = [];

  for (let i = Math.max(1, startIdx); i < bars.length; i++) {
    // Gap up: current bar's low is above previous bar's high
    if (bars[i].l > bars[i - 1].h) {
      gaps.push({ type: 'up', gapStart: round(bars[i - 1].h), gapEnd: round(bars[i].l), barIdx: i });
    }
    // Gap down: current bar's high is below previous bar's low
    if (bars[i].h < bars[i - 1].l) {
      gaps.push({ type: 'down', gapStart: round(bars[i - 1].l), gapEnd: round(bars[i].h), barIdx: i });
    }
  }

  // Check if each gap has been filled by any subsequent bar
  return gaps.map(g => {
    let filled = false;
    for (let j = g.barIdx + 1; j < bars.length; j++) {
      if (g.type === 'up' && bars[j].l <= g.gapStart) { filled = true; break; }
      if (g.type === 'down' && bars[j].h >= g.gapStart) { filled = true; break; }
    }
    return { type: g.type, gapStart: g.gapStart, gapEnd: g.gapEnd, filled };
  });
}

// ── Recent Move (% change over N bars) ──────────────────

export interface RecentMove {
  change5: number | null;   // % change over last 5 bars
  change10: number | null;  // % change over last 10 bars
  change20: number | null;  // % change over last 20 bars
}

/** Compute recent % moves. Data is newest-first. */
export function computeRecentMove(data: OHLCV[]): RecentMove {
  const cur = data.length > 0 ? data[0].c : 0;
  const pct = (idx: number) => {
    if (data.length <= idx || cur === 0) return null;
    const prev = data[idx].c;
    return prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null;
  };
  return { change5: pct(5), change10: pct(10), change20: pct(20) };
}

// ── Full Indicator Summary ──────────────────────────────

export interface IndicatorSummary {
  rsi: number | null;
  macd: MACDResult | null;
  ema20: number | null;
  sma50: number | null;
  sma200: number | null;
  atr: number | null;
  adx: number | null;
  volumeRatio: { current: number; average: number; ratio: number } | null;
  supportResistance: SupportResistance;
  emaCrossover: CrossoverState;
  trend: TrendLabel;
  recentMove: RecentMove;
  gaps: GapInfo[];
}

/**
 * Compute all indicators from an OHLCV array (newest-first).
 * Needs at least ~200 bars for SMA(200); returns null for indicators
 * that don't have enough data.
 */
export function computeAllIndicators(data: OHLCV[]): IndicatorSummary {
  const ema20 = maybeRound(computeEMA(data, 20));
  const sma50 = maybeRound(computeSMA(data, 50));
  const sma200 = maybeRound(computeSMA(data, 200));
  const currentPrice = data.length > 0 ? data[0].c : 0;

  return {
    rsi: maybeRound(computeRSI(data)),
    macd: computeMACD(data),
    ema20,
    sma50,
    sma200,
    atr: maybeRound(computeATR(data)),
    adx: maybeRound(computeADX(data)),
    volumeRatio: computeVolumeRatio(data),
    supportResistance: computeSupportResistance(data),
    emaCrossover: detectEMASMACrossover(data),
    trend: classifyTrend(currentPrice, sma50, sma200),
    recentMove: computeRecentMove(data),
    gaps: detectGaps(data),
  };
}

// ── Formatting ──────────────────────────────────────────

function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function maybeRound(n: number | null, decimals = 2): number | null {
  return n === null ? null : round(n, decimals);
}

/**
 * Build a human-readable indicator summary string for AI prompt injection.
 * currentPrice is the latest close.
 */
export function formatIndicatorsForPrompt(
  ind: IndicatorSummary,
  currentPrice: number,
  marketContext?: string
): string {
  const lines: string[] = [
    'TECHNICAL INDICATORS (pre-computed from candle data):',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ];

  // Momentum
  lines.push('Momentum:');
  if (ind.rsi !== null) {
    const rsiLabel = ind.rsi > 70 ? 'overbought' : ind.rsi < 30 ? 'oversold' : ind.rsi > 50 ? 'bullish, not overbought' : 'bearish, not oversold';
    lines.push(`  RSI(14): ${ind.rsi} — ${rsiLabel}`);
  }
  if (ind.macd) {
    const macdBias = ind.macd.histogram > 0 ? 'bullish' : 'bearish';
    const crossover = Math.abs(ind.macd.histogram) < 0.5 ? ' (near crossover)' : '';
    lines.push(`  MACD(12,26,9): line ${ind.macd.value}, signal ${ind.macd.signal}, histogram ${ind.macd.histogram > 0 ? '+' : ''}${ind.macd.histogram} — ${macdBias}${crossover}`);
  }

  // Trend
  lines.push('');
  lines.push('Trend:');
  if (ind.ema20 !== null) {
    const bias = currentPrice > ind.ema20 ? 'price ABOVE (bullish short-term)' : 'price BELOW (bearish short-term)';
    lines.push(`  EMA(20): $${ind.ema20} — ${bias}`);
  }
  if (ind.sma50 !== null) {
    const bias = currentPrice > ind.sma50 ? 'price ABOVE (bullish medium-term)' : 'price BELOW (bearish medium-term)';
    lines.push(`  SMA(50): $${ind.sma50} — ${bias}`);
  }
  if (ind.sma200 !== null) {
    const bias = currentPrice > ind.sma200 ? 'price ABOVE (bullish long-term)' : 'price BELOW (bearish long-term)';
    lines.push(`  SMA(200): $${ind.sma200} — ${bias}`);
  }
  if (ind.adx !== null) {
    const label = ind.adx >= 25 ? 'TRENDING' : 'WEAK/NO TREND';
    lines.push(`  ADX(14): ${ind.adx} — ${label} (${ind.adx >= 25 ? 'above' : 'below'} 25 threshold)`);
  }

  // EMA/SMA Crossover
  if (ind.emaCrossover) {
    const crossLabels: Record<string, string> = {
      bullish_cross: 'EMA(20) JUST CROSSED ABOVE SMA(50) — bullish crossover signal',
      bearish_cross: 'EMA(20) JUST CROSSED BELOW SMA(50) — bearish crossover signal',
      above: 'EMA(20) above SMA(50) — bullish alignment',
      below: 'EMA(20) below SMA(50) — bearish alignment',
    };
    lines.push(`  MA Crossover: ${crossLabels[ind.emaCrossover]}`);
  }

  // Trend classification
  const trendLabels: Record<string, string> = {
    strong_uptrend: 'STRONG UPTREND (price > SMA50 > SMA200)',
    uptrend: 'UPTREND (price above both MAs)',
    sideways: 'SIDEWAYS / MIXED (MAs conflicting)',
    downtrend: 'DOWNTREND (price below both MAs)',
    strong_downtrend: 'STRONG DOWNTREND (price < SMA50 < SMA200)',
  };
  lines.push(`  Overall Trend: ${trendLabels[ind.trend] ?? 'Unknown'}`);

  // Volatility
  lines.push('');
  lines.push('Volatility:');
  if (ind.atr !== null) {
    const pct = round((ind.atr / currentPrice) * 100);
    const label = pct > 3 ? 'high' : pct > 1.5 ? 'moderate' : 'low';
    lines.push(`  ATR(14): $${ind.atr} (${pct}% of price) — ${label}`);
  }

  // Volume
  if (ind.volumeRatio) {
    lines.push('');
    lines.push('Volume:');
    const vr = ind.volumeRatio;
    const fmt = (n: number) => n >= 1_000_000 ? `${round(n / 1_000_000, 1)}M` : n >= 1_000 ? `${round(n / 1_000, 1)}K` : `${round(n)}`;
    const volLabel = vr.ratio >= 3 ? '⚠️ SURGE (3x+) — strong institutional activity'
      : vr.ratio >= 1.5 ? 'HIGH (1.5x+) — confirms move'
      : vr.ratio >= 0.8 ? 'NORMAL — no unusual activity'
      : '⚠️ DRY (< 0.8x) — move is suspect, low conviction';
    lines.push(`  Current: ${fmt(vr.current)} vs 20-day avg ${fmt(vr.average)} — ${vr.ratio}x ${volLabel}`);
  }

  // Recent price move — critical for "don't chase" logic
  const rm = ind.recentMove;
  if (rm.change5 !== null || rm.change10 !== null || rm.change20 !== null) {
    lines.push('');
    lines.push('Recent Price Move:');
    if (rm.change5 !== null) {
      const label5 = Math.abs(rm.change5) > 15 ? ' ⚠️ PARABOLIC' : Math.abs(rm.change5) > 8 ? ' ⚠️ EXTENDED' : '';
      lines.push(`  5-bar change: ${rm.change5 > 0 ? '+' : ''}${rm.change5}%${label5}`);
    }
    if (rm.change10 !== null) {
      const label10 = Math.abs(rm.change10) > 25 ? ' ⚠️ PARABOLIC' : Math.abs(rm.change10) > 15 ? ' ⚠️ EXTENDED' : '';
      lines.push(`  10-bar change: ${rm.change10 > 0 ? '+' : ''}${rm.change10}%${label10}`);
    }
    if (rm.change20 !== null) {
      const label20 = Math.abs(rm.change20) > 40 ? ' ⚠️ PARABOLIC' : Math.abs(rm.change20) > 25 ? ' ⚠️ EXTENDED' : '';
      lines.push(`  20-bar change: ${rm.change20 > 0 ? '+' : ''}${rm.change20}%${label20}`);
    }
  }

  // Key levels
  const sr = ind.supportResistance;
  if (sr.support.length > 0 || sr.resistance.length > 0) {
    lines.push('');
    lines.push('Key Levels:');
    if (sr.support.length > 0) lines.push(`  Support: ${sr.support.map(p => `$${p}`).join(', ')}`);
    if (sr.resistance.length > 0) lines.push(`  Resistance: ${sr.resistance.map(p => `$${p}`).join(', ')}`);
  }

  // Price gaps
  const unfilledGaps = ind.gaps.filter(g => !g.filled);
  if (unfilledGaps.length > 0) {
    lines.push('');
    lines.push('Unfilled Price Gaps:');
    for (const g of unfilledGaps.slice(0, 4)) {  // limit to 4 most relevant
      const dir = g.type === 'up' ? 'Gap Up' : 'Gap Down';
      lines.push(`  ${dir}: $${g.gapStart} – $${g.gapEnd} (unfilled — potential magnet)`);
    }
  }

  // Market context
  if (marketContext) {
    lines.push('');
    lines.push('Market Context:');
    lines.push(`  ${marketContext}`);
  }

  return lines.join('\n');
}
