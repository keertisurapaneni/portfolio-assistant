/**
 * 100 EMA higher-timeframe trend filter for DAY_TRADE signals.
 *
 * Inspired by Trade by Pat's break-and-retest framework: only take day trade
 * entries when the 4H trend confirms the direction. Buys require price above
 * the 4H 100 EMA with a positive slope; sells require the inverse.
 *
 * Non-blocking: returns { pass: true } if data is unavailable so we never
 * silently kill trades due to API failures.
 */

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};
const TIMEOUT_MS = 12_000;
const EMA_PERIOD = 100;
const SLOPE_LOOKBACK = 5; // compare current EMA vs 5 bars ago

interface Bar4H {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TrendFilterResult {
  pass: boolean;
  reason: string;
  price?: number;
  ema100?: number;
  slope?: number;
}

async function fetch1hCandles(ticker: string): Promise<Bar4H[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=6mo&interval=1h&includePrePost=false`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json() as Record<string, unknown>;
    const result = (data?.chart as Record<string, unknown>)?.result as Record<string, unknown>[] | undefined;
    if (!result?.[0]) return [];

    const r = result[0];
    const timestamps = (r.timestamp as number[]) ?? [];
    const quotes = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] ?? {};
    const opens = quotes.open as (number | null)[];
    const highs = quotes.high as (number | null)[];
    const lows = quotes.low as (number | null)[];
    const closes = quotes.close as (number | null)[];
    const volumes = quotes.volume as (number | null)[];

    const bars: Bar4H[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] != null && highs[i] != null && lows[i] != null && closes[i] != null) {
        bars.push({
          t: timestamps[i],
          o: opens[i]!,
          h: highs[i]!,
          l: lows[i]!,
          c: closes[i]!,
          v: volumes[i] ?? 0,
        });
      }
    }
    return bars;
  } catch {
    return [];
  }
}

function synthesize4HBars(bars1h: Bar4H[]): Bar4H[] {
  if (bars1h.length === 0) return [];

  const bars4h: Bar4H[] = [];
  let bucket: Bar4H[] = [];

  for (const bar of bars1h) {
    const d = new Date(bar.t * 1000);
    const hour = d.getUTCHours();
    const bucketHour = Math.floor(hour / 4) * 4;

    if (bucket.length > 0) {
      const firstD = new Date(bucket[0].t * 1000);
      const firstBucket = Math.floor(firstD.getUTCHours() / 4) * 4;
      const sameDay = firstD.toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
      if (!sameDay || bucketHour !== firstBucket) {
        bars4h.push(aggregate(bucket));
        bucket = [];
      }
    }
    bucket.push(bar);
  }
  if (bucket.length > 0) bars4h.push(aggregate(bucket));

  return bars4h;
}

function aggregate(bars: Bar4H[]): Bar4H {
  return {
    t: bars[0].t,
    o: bars[0].o,
    h: Math.max(...bars.map(b => b.h)),
    l: Math.min(...bars.map(b => b.l)),
    c: bars[bars.length - 1].c,
    v: bars.reduce((s, b) => s + b.v, 0),
  };
}

function computeEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(prev);
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

/**
 * Check whether the 4H trend supports a given trade direction.
 *
 * For BUY: price must be above 4H 100 EMA AND EMA slope positive.
 * For SELL: price must be below 4H 100 EMA AND EMA slope negative.
 *
 * Returns { pass: true } on data failure (non-blocking).
 */
export async function checkTrendFilter(
  ticker: string,
  signal: 'BUY' | 'SELL',
): Promise<TrendFilterResult> {
  const bars1h = await fetch1hCandles(ticker);
  if (bars1h.length < EMA_PERIOD + SLOPE_LOOKBACK) {
    return { pass: true, reason: 'insufficient 1h data — filter bypassed' };
  }

  const bars4h = synthesize4HBars(bars1h);
  if (bars4h.length < EMA_PERIOD + SLOPE_LOOKBACK) {
    return { pass: true, reason: 'insufficient 4h data — filter bypassed' };
  }

  const closes = bars4h.map(b => b.c);
  const ema = computeEMA(closes, EMA_PERIOD);
  if (ema.length < SLOPE_LOOKBACK + 1) {
    return { pass: true, reason: 'EMA series too short — filter bypassed' };
  }

  const currentEma = ema[ema.length - 1];
  const pastEma = ema[ema.length - 1 - SLOPE_LOOKBACK];
  const slope = currentEma - pastEma;
  const price = closes[closes.length - 1];

  if (signal === 'BUY') {
    const aboveEma = price > currentEma;
    const slopePositive = slope > 0;
    if (!aboveEma || !slopePositive) {
      return {
        pass: false,
        reason: `4H trend against BUY: price ${aboveEma ? 'above' : 'below'} 100 EMA ($${currentEma.toFixed(2)}), slope ${slopePositive ? '+' : ''}${slope.toFixed(2)}`,
        price, ema100: currentEma, slope,
      };
    }
    return {
      pass: true,
      reason: `4H trend confirms BUY: price above 100 EMA, slope +${slope.toFixed(2)}`,
      price, ema100: currentEma, slope,
    };
  } else {
    const belowEma = price < currentEma;
    const slopeNegative = slope < 0;
    if (!belowEma || !slopeNegative) {
      return {
        pass: false,
        reason: `4H trend against SELL: price ${belowEma ? 'below' : 'above'} 100 EMA ($${currentEma.toFixed(2)}), slope ${slope.toFixed(2)}`,
        price, ema100: currentEma, slope,
      };
    }
    return {
      pass: true,
      reason: `4H trend confirms SELL: price below 100 EMA, slope ${slope.toFixed(2)}`,
      price, ema100: currentEma, slope,
    };
  }
}
