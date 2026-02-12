// Portfolio Assistant — Trade Scanner Edge Function
//
// Scans market movers + a curated universe to find the best day trade
// and swing trade candidates. Returns only HIGH-CONFIDENCE setups
// with explicit BUY / SELL direction.
//
// NO Gemini / AI calls — pure data + scoring. Fast and cheap.
// Full AI analysis happens when the user clicks a pick on the frontend.
//
// Data flow:
//   Yahoo Finance screener (gainers + losers) → day trade candidates
//   Yahoo Finance chart API (v8, 1y daily) → swing trade candidates
//   SMA50 / SMA200 computed from historical closes (v7 batch-quote is auth-gated)
//
// Returns { dayTrades, swingTrades, timestamp }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Types ───────────────────────────────────────────────

interface TradeIdea {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  signal: 'BUY' | 'SELL';
  confidence: 'Very High' | 'High' | 'Moderate';
  score: number;        // 0-100 internal score
  reason: string;       // human-readable mini-summary
  tags: string[];       // e.g. ["momentum", "volume-surge"]
  mode: 'DAY_TRADE' | 'SWING_TRADE';
}

interface ScanResult {
  dayTrades: TradeIdea[];
  swingTrades: TradeIdea[];
  timestamp: number;
  cached?: boolean;
}

interface YahooQuote {
  symbol: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice: number | { raw: number };
  regularMarketChange: number | { raw: number };
  regularMarketChangePercent: number | { raw: number };
  regularMarketVolume: number | { raw: number };
  averageDailyVolume10Day?: number | { raw: number };
  regularMarketDayHigh?: number | { raw: number };
  regularMarketDayLow?: number | { raw: number };
  regularMarketOpen?: number | { raw: number };
  regularMarketPreviousClose?: number | { raw: number };
  fiftyTwoWeekHigh?: number | { raw: number };
  fiftyTwoWeekLow?: number | { raw: number };
  fiftyDayAverage?: number | { raw: number };
  twoHundredDayAverage?: number | { raw: number };
  marketCap?: number | { raw: number };
}

// ── Curated swing universe ──────────────────────────────

const SWING_UNIVERSE = [
  // Mega-cap tech
  'AAPL', 'MSFT', 'NVDA', 'GOOG', 'AMZN', 'META', 'TSLA', 'AVGO', 'ORCL', 'CRM',
  'ADBE', 'AMD', 'NFLX', 'INTC', 'QCOM', 'AMAT', 'MU',
  // Finance
  'JPM', 'V', 'MA', 'BAC', 'GS',
  // Healthcare
  'UNH', 'LLY', 'JNJ', 'ABBV', 'MRK', 'PFE',
  // Consumer
  'COST', 'WMT', 'HD', 'NKE', 'MCD', 'SBUX',
  // Industrial & Energy
  'CAT', 'BA', 'GE', 'XOM', 'CVX',
  // Growth & trending
  'COIN', 'PLTR', 'SOFI', 'SNOW', 'SHOP', 'SQ', 'ROKU', 'NET', 'CRWD', 'PANW',
];

// ── Helpers ─────────────────────────────────────────────

function rawVal(v: number | { raw: number } | undefined | null): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.raw : v;
}

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function confidenceLabel(score: number): 'Very High' | 'High' | 'Moderate' {
  if (score >= 80) return 'Very High';
  if (score >= 65) return 'High';
  return 'Moderate';
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://finance.yahoo.com/',
};

// ── Yahoo Finance data fetchers ─────────────────────────

async function fetchMovers(type: 'day_gainers' | 'day_losers'): Promise<YahooQuote[]> {
  try {
    const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved');
    url.searchParams.set('formatted', 'false');
    url.searchParams.set('scrIds', type);
    url.searchParams.set('start', '0');
    url.searchParams.set('count', '25');
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');

    const res = await fetch(url.toString(), { headers: YAHOO_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.finance?.result?.[0]?.quotes ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch quote data for a single symbol using Yahoo's chart endpoint (v8).
 * The v7 batch-quote endpoint now requires auth, but the chart endpoint still works.
 * We pull 1 year of daily data so we can compute SMA50 and SMA200 ourselves.
 */
async function fetchChartQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta ?? {};
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes: (number | null)[] = quotes.close ?? [];
    const volumes: (number | null)[] = quotes.volume ?? [];
    const validCloses = closes.filter((c): c is number => c != null);
    const validVolumes = volumes.filter((v): v is number => v != null);

    // Calculate SMAs from historical closes
    const sma50 = validCloses.length >= 50
      ? validCloses.slice(-50).reduce((a, b) => a + b, 0) / 50
      : 0;
    const sma200 = validCloses.length >= 200
      ? validCloses.slice(-200).reduce((a, b) => a + b, 0) / 200
      : 0;

    // Average volume over last 10 trading days
    const avgVol10 = validVolumes.length >= 10
      ? validVolumes.slice(-10).reduce((a, b) => a + b, 0) / 10
      : 0;

    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : 0);

    return {
      symbol: meta.symbol ?? symbol,
      shortName: meta.shortName,
      longName: meta.longName,
      regularMarketPrice: price,
      regularMarketChange: prevClose > 0 ? price - prevClose : 0,
      regularMarketChangePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      regularMarketVolume: meta.regularMarketVolume ?? (validVolumes.length > 0 ? validVolumes[validVolumes.length - 1] : 0),
      averageDailyVolume10Day: avgVol10,
      regularMarketDayHigh: meta.regularMarketDayHigh ?? 0,
      regularMarketDayLow: meta.regularMarketDayLow ?? 0,
      regularMarketOpen: validCloses.length > 0 ? (quotes.open ?? [])[closes.length - 1] ?? 0 : 0,
      regularMarketPreviousClose: prevClose,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
      fiftyDayAverage: sma50,
      twoHundredDayAverage: sma200,
    };
  } catch (e) {
    console.warn(`[Trade Scanner] Chart fetch failed for ${symbol}:`, e);
    return null;
  }
}

/**
 * Fetch quotes for multiple symbols using parallel chart requests.
 * Batches in groups of 10 to avoid overwhelming the endpoint.
 */
async function fetchSwingQuotes(symbols: string[]): Promise<YahooQuote[]> {
  if (symbols.length === 0) return [];
  const BATCH_SIZE = 10;
  const results: YahooQuote[] = [];

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(fetchChartQuote));
    for (const q of batchResults) {
      if (q) results.push(q);
    }
  }

  console.log(`[Trade Scanner] Chart quotes: ${results.length}/${symbols.length} succeeded, ${results.filter(q => rawVal(q.fiftyDayAverage) > 0).length} have SMA50, ${results.filter(q => rawVal(q.twoHundredDayAverage) > 0).length} have SMA200`);
  return results;
}

// ── Day Trade Scoring ───────────────────────────────────
// Scores both BUY (momentum continuation) and SELL (overextended short).
//
// Signal logic:
//   Gainers 3-20%  → BUY  (ride the momentum)
//   Gainers >25%   → SELL (overextended, likely to fade — short candidate)
//   Losers  3-20%  → SELL (ride the breakdown)
//   Losers  >25%   → skip (too risky for either direction)

function scoreDayTrade(q: YahooQuote, source: 'gainers' | 'losers'): TradeIdea | null {
  const price = rawVal(q.regularMarketPrice);
  const change = rawVal(q.regularMarketChange);
  const changePct = rawVal(q.regularMarketChangePercent);
  const volume = rawVal(q.regularMarketVolume);
  const avgVolume = rawVal(q.averageDailyVolume10Day);
  const high = rawVal(q.regularMarketDayHigh);
  const low = rawVal(q.regularMarketDayLow);
  const open = rawVal(q.regularMarketOpen);
  const prevClose = rawVal(q.regularMarketPreviousClose);

  if (price <= 2 || !q.symbol) return null;

  const absPct = Math.abs(changePct);
  if (absPct < 2) return null; // not enough movement

  // Determine signal direction
  let signal: 'BUY' | 'SELL';
  if (source === 'gainers') {
    // Extreme gainers (>25%) = SELL (overextended, fade the move)
    // Moderate gainers (3-25%) = BUY (momentum continuation)
    signal = absPct > 25 ? 'SELL' : 'BUY';
  } else {
    // Losers are SELL candidates (short / ride breakdown)
    signal = 'SELL';
  }

  let score = 0;
  const tags: string[] = [];
  const reasons: string[] = [];

  // For SELL on overextended gainers, add specific tags
  if (source === 'gainers' && signal === 'SELL') {
    tags.push('overextended');
    reasons.push(`Up ${round(absPct, 1)}% — extended`);
  }

  // ── 1. Change% (max 30 pts) — sweet spot is 3-15% for BUY, higher for SELL
  if (signal === 'BUY') {
    if (absPct >= 4 && absPct <= 10) score += 30;
    else if (absPct > 10 && absPct <= 20) score += 25;
    else if (absPct >= 3 && absPct < 4) score += 22;
    else if (absPct > 20 && absPct <= 25) score += 18;
    else if (absPct >= 2) score += 12;
  } else {
    // SELL: larger moves = more conviction for mean reversion or breakdown
    if (absPct >= 4 && absPct <= 15) score += 30;
    else if (absPct > 15 && absPct <= 30) score += 25;
    else if (absPct > 30 && absPct <= 50) score += 22;
    else if (absPct > 50) score += 15; // extreme = risky even to short
    else if (absPct >= 2) score += 15;
  }

  if (absPct >= 5) tags.push('momentum');

  // ── 2. Volume confirmation (max 30 pts)
  if (avgVolume > 0) {
    const volRatio = volume / avgVolume;
    if (volRatio >= 4) { score += 30; tags.push('volume-surge'); reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
    else if (volRatio >= 2.5) { score += 26; tags.push('high-volume'); reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
    else if (volRatio >= 1.5) { score += 20; reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
    else if (volRatio >= 1) score += 10;
    else score += 2;
  } else if (volume > 2_000_000) {
    score += 12;
  } else {
    score += 2;
  }

  // ── 3. Price range (max 15 pts)
  if (price >= 10 && price <= 200) score += 15;
  else if (price >= 5 && price < 10) score += 8;
  else if (price > 200 && price <= 500) score += 12;
  else if (price > 500) score += 8;

  // ── 4. Intraday range (max 15 pts)
  if (high > 0 && low > 0 && price > 0) {
    const rangePct = ((high - low) / price) * 100;
    if (rangePct > 6) { score += 15; tags.push('wide-range'); }
    else if (rangePct > 4) score += 12;
    else if (rangePct > 2) score += 8;
    else score += 3;
  }

  // ── 5. Gap factor (max 10 pts)
  if (prevClose > 0 && open > 0) {
    const gapPct = ((open - prevClose) / prevClose) * 100;
    if (Math.abs(gapPct) > 4) { score += 10; tags.push('gap'); reasons.push(`Gapped ${gapPct > 0 ? '+' : ''}${round(gapPct, 1)}%`); }
    else if (Math.abs(gapPct) > 2) score += 6;
  }

  const finalScore = Math.min(100, score);

  // Build reason string
  const direction = changePct > 0 ? 'Up' : 'Down';
  const mainReason = signal === 'SELL' && source === 'gainers'
    ? `Up ${round(absPct, 1)}% — overextended short`
    : `${direction} ${round(absPct, 1)}%`;
  const extra = reasons.filter(r => !r.startsWith('Up ')).length > 0
    ? ` · ${reasons.filter(r => !r.startsWith('Up ')).join(' · ')}`
    : '';

  return {
    ticker: q.symbol,
    name: q.shortName ?? q.longName ?? q.symbol,
    price: round(price),
    change: round(change),
    changePercent: round(changePct, 1),
    signal,
    confidence: confidenceLabel(finalScore),
    score: finalScore,
    reason: `${mainReason}${extra}`,
    tags,
    mode: 'DAY_TRADE',
  };
}

// ── Swing Trade Scoring ─────────────────────────────────
// BUY: pullback in confirmed uptrend + near support.
// SELL: breakdown in confirmed downtrend + near resistance.

function scoreSwingTrade(q: YahooQuote): TradeIdea | null {
  const price = rawVal(q.regularMarketPrice);
  const change = rawVal(q.regularMarketChange);
  const changePct = rawVal(q.regularMarketChangePercent);
  const high52 = rawVal(q.fiftyTwoWeekHigh);
  const low52 = rawVal(q.fiftyTwoWeekLow);
  const sma50 = rawVal(q.fiftyDayAverage);
  const sma200 = rawVal(q.twoHundredDayAverage);
  const volume = rawVal(q.regularMarketVolume);
  const avgVolume = rawVal(q.averageDailyVolume10Day);

  if (price <= 0 || !q.symbol) return null;

  let score = 0;
  const tags: string[] = [];
  const reasons: string[] = [];

  const hasSma50 = sma50 > 0;
  const hasSma200 = sma200 > 0;
  const aboveSma50 = hasSma50 && price > sma50;
  const aboveSma200 = hasSma200 && price > sma200;
  const sma50Above200 = hasSma50 && hasSma200 && sma50 > sma200;
  const belowSma50 = hasSma50 && price < sma50;
  const belowSma200 = hasSma200 && price < sma200;
  const sma50Below200 = hasSma50 && hasSma200 && sma50 < sma200;

  // 52-week position (used as trend proxy when SMAs are unavailable)
  const has52w = high52 > 0 && low52 > 0 && high52 > low52;
  const weekPos = has52w ? (price - low52) / (high52 - low52) : 0.5;

  // Determine trend direction — prefer SMA data, fallback to 52-week position
  let isUptrend = false;
  let isDowntrend = false;
  if (hasSma50 && hasSma200) {
    isUptrend = aboveSma50 && aboveSma200;
    isDowntrend = belowSma50 && belowSma200;
  } else if (hasSma50) {
    isUptrend = aboveSma50 && weekPos >= 0.6;
    isDowntrend = belowSma50 && weekPos <= 0.4;
  } else {
    // No SMA data at all — use 52-week position as proxy
    isUptrend = weekPos >= 0.65;
    isDowntrend = weekPos <= 0.35;
  }

  const signal: 'BUY' | 'SELL' = isDowntrend && !isUptrend ? 'SELL' : 'BUY';

  if (signal === 'BUY') {
    // ── BUY: Pullback in uptrend ──

    // 1. Uptrend confirmation (max 30 pts)
    if (aboveSma50 && aboveSma200 && sma50Above200) {
      score += 30; tags.push('strong-uptrend');
    } else if (aboveSma50 && aboveSma200) {
      score += 24; tags.push('uptrend');
    } else if (aboveSma200 && !aboveSma50) {
      score += 18; tags.push('pullback-zone');
    } else if (aboveSma50) {
      score += 18; tags.push('uptrend');
    } else if (has52w && weekPos >= 0.7) {
      // Fallback: near 52-week high = likely uptrend
      score += 22; tags.push('near-highs');
    } else if (has52w && weekPos >= 0.6) {
      score += 15; tags.push('upper-range');
    } else {
      score += 5;
    }

    // 2. Pullback quality (max 25 pts) — dip, not crash
    if (changePct <= -1 && changePct > -4) {
      score += 25; tags.push('pullback'); reasons.push(`Dipped ${round(Math.abs(changePct), 1)}%`);
    } else if (changePct <= -4 && changePct > -8) {
      score += 20; tags.push('pullback'); reasons.push(`Dipped ${round(Math.abs(changePct), 1)}%`);
    } else if (changePct <= -8 && changePct > -12) {
      score += 12; tags.push('sell-off'); reasons.push(`Sold off ${round(Math.abs(changePct), 1)}%`);
    } else if (changePct <= -12) {
      score += 5; tags.push('crash');
    } else if (changePct < 0) {
      score += 15;
    } else if (changePct >= 0 && changePct < 0.5) {
      score += 8; // flat day in uptrend = still a decent entry
    } else {
      score += 3;
    }

    // 3. Proximity to support (max 20 pts) — prefer SMA50, fallback to 52w range
    if (hasSma50) {
      const distPct = ((price - sma50) / sma50) * 100;
      if (distPct >= 0 && distPct <= 2) { score += 20; tags.push('at-sma50'); reasons.push('At SMA(50) support'); }
      else if (distPct >= -2 && distPct < 0) { score += 18; tags.push('testing-sma50'); reasons.push('Testing SMA(50)'); }
      else if (distPct > 2 && distPct <= 5) score += 12;
      else if (distPct > 5 && distPct <= 10) score += 6;
      else if (distPct > 10) score += 2;
      else score += 5;
    } else if (has52w) {
      // No SMA50 — use distance from 52w high as proxy for "discount from trend"
      const pctFromHigh = ((high52 - price) / high52) * 100;
      if (pctFromHigh >= 5 && pctFromHigh <= 15) { score += 18; reasons.push(`${round(pctFromHigh, 0)}% off 52w high`); }
      else if (pctFromHigh >= 2 && pctFromHigh < 5) { score += 14; reasons.push(`${round(pctFromHigh, 0)}% off 52w high`); }
      else if (pctFromHigh > 15 && pctFromHigh <= 25) score += 10;
      else score += 4;
    }

    // 4. 52-week position (max 15 pts) — upper half = healthy
    if (has52w) {
      const pctFromHigh = round((1 - weekPos) * 100, 0);
      if (weekPos >= 0.8) { score += 15; reasons.push(`${pctFromHigh}% from 52w high`); }
      else if (weekPos >= 0.65) { score += 12; reasons.push(`${pctFromHigh}% from 52w high`); }
      else if (weekPos >= 0.5) score += 8;
      else score += 2;
    }

    // 5. Volume on pullback (max 10 pts) — quiet dips are healthy
    if (avgVolume > 0 && volume > 0 && changePct < 0) {
      const volRatio = volume / avgVolume;
      if (volRatio < 0.7) { score += 10; tags.push('quiet-dip'); reasons.push('Low-vol pullback'); }
      else if (volRatio < 1) score += 7;
      else if (volRatio > 2) score -= 5;
    }
  } else {
    // ── SELL: Breakdown in downtrend ──

    // 1. Downtrend confirmation (max 30 pts)
    if (belowSma50 && belowSma200 && sma50Below200) {
      score += 30; tags.push('strong-downtrend');
    } else if (belowSma50 && belowSma200) {
      score += 24; tags.push('downtrend');
    } else if (belowSma50) {
      score += 18; tags.push('weakening');
    } else if (has52w && weekPos <= 0.3) {
      // Fallback: near 52-week low = likely downtrend
      score += 22; tags.push('near-lows');
    } else if (has52w && weekPos <= 0.4) {
      score += 15; tags.push('lower-range');
    } else {
      score += 5;
    }

    // 2. Breakdown quality (max 25 pts) — bounce into resistance then reject
    if (changePct >= 1 && changePct < 4) {
      // Small bounce in downtrend = potential short entry at resistance
      score += 20; tags.push('bounce'); reasons.push(`Bounced ${round(changePct, 1)}% into resistance`);
    } else if (changePct < 0 && changePct > -5) {
      score += 22; tags.push('breakdown'); reasons.push(`Down ${round(Math.abs(changePct), 1)}% — trend continuing`);
    } else if (changePct <= -5 && changePct > -10) {
      score += 15; reasons.push(`Down ${round(Math.abs(changePct), 1)}%`);
    } else if (changePct >= 4) {
      score += 5; // big bounce = might be reversing, low confidence short
    } else if (changePct >= 0 && changePct < 1) {
      score += 10; // flat day in downtrend
    }

    // 3. Proximity to resistance (max 20 pts) — prefer SMA50, fallback to 52w
    if (hasSma50) {
      const distPct = ((price - sma50) / sma50) * 100;
      if (distPct >= -2 && distPct <= 0) { score += 20; tags.push('at-sma50'); reasons.push('Rejected at SMA(50)'); }
      else if (distPct > 0 && distPct <= 2) { score += 18; tags.push('testing-sma50'); reasons.push('Testing SMA(50) resistance'); }
      else if (distPct < -2 && distPct >= -5) score += 12;
      else if (distPct < -5) score += 6;
      else score += 3;
    } else if (has52w) {
      // No SMA50 — use distance from 52w low
      const pctFromLow = ((price - low52) / low52) * 100;
      if (pctFromLow <= 15) { score += 16; reasons.push(`Near 52w low`); }
      else if (pctFromLow <= 30) score += 10;
      else score += 4;
    }

    // 4. 52-week position (max 15 pts) — lower half = bearish
    if (has52w) {
      const pctFromLow = round(weekPos * 100, 0);
      if (weekPos <= 0.3) { score += 15; reasons.push(`${pctFromLow}% above 52w low`); }
      else if (weekPos <= 0.45) { score += 12; reasons.push(`Lower half of 52w range`); }
      else if (weekPos <= 0.6) score += 6;
      else score += 0; // upper half = uptrend context, bad short
    }

    // 5. Volume on breakdown (max 10 pts) — heavy selling confirms
    if (avgVolume > 0 && volume > 0 && changePct < 0) {
      const volRatio = volume / avgVolume;
      if (volRatio > 2) { score += 10; tags.push('heavy-selling'); reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
      else if (volRatio > 1.2) score += 6;
    }
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const reasonStr = reasons.length > 0 ? reasons.join(' · ') : `${round(changePct, 1)}% today`;

  return {
    ticker: q.symbol,
    name: q.shortName ?? q.longName ?? q.symbol,
    price: round(price),
    change: round(change),
    changePercent: round(changePct, 1),
    signal,
    confidence: confidenceLabel(finalScore),
    score: finalScore,
    reason: reasonStr,
    tags,
    mode: 'SWING_TRADE',
  };
}

// ── In-memory cache ─────────────────────────────────────

let _cachedResult: ScanResult | null = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

// ── Main handler ────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let portfolioTickers: string[] = [];
    try {
      const body = await req.json();
      if (Array.isArray(body?.portfolioTickers)) {
        portfolioTickers = body.portfolioTickers
          .map((t: unknown) => String(t).trim().toUpperCase())
          .filter((t: string) => t.length > 0 && t.length <= 10);
      }
    } catch {
      // No body or invalid JSON — fine
    }

    const now = Date.now();
    if (_cachedResult && now - _cacheTimestamp < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ..._cachedResult, cached: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[Trade Scanner] Scanning...`);

    const swingSymbols = [...new Set([...SWING_UNIVERSE, ...portfolioTickers])];

    // Fetch gainers + losers for day trades, chart quotes for swing
    const [gainers, losers, swingQuotes] = await Promise.all([
      fetchMovers('day_gainers'),
      fetchMovers('day_losers'),
      fetchSwingQuotes(swingSymbols),
    ]);

    console.log(`[Trade Scanner] Got ${gainers.length} gainers, ${losers.length} losers, ${swingQuotes.length} swing quotes`);

    // ── Score day trades (BUY from gainers, SELL from losers + overextended gainers) ──
    const dayBuys = gainers
      .map(q => scoreDayTrade(q, 'gainers'))
      .filter((x): x is TradeIdea => x !== null && x.score >= 55);
    const daySells = losers
      .map(q => scoreDayTrade(q, 'losers'))
      .filter((x): x is TradeIdea => x !== null && x.score >= 55);

    // Merge, dedupe, sort by score, take top 8
    const dayAll = [...dayBuys, ...daySells]
      .sort((a, b) => b.score - a.score);
    // Dedupe by ticker (keep highest score)
    const daySeen = new Set<string>();
    const dayIdeas: TradeIdea[] = [];
    for (const idea of dayAll) {
      if (!daySeen.has(idea.ticker) && dayIdeas.length < 8) {
        daySeen.add(idea.ticker);
        dayIdeas.push(idea);
      }
    }

    // ── Score swing trades (BUY pullbacks + SELL breakdowns) ──
    const swingAll = swingQuotes
      .map(scoreSwingTrade)
      .filter((x): x is TradeIdea => x !== null && x.score >= 50)
      .sort((a, b) => b.score - a.score);
    const swingSeen = new Set<string>();
    const swingIdeas: TradeIdea[] = [];
    for (const idea of swingAll) {
      if (!swingSeen.has(idea.ticker) && swingIdeas.length < 8) {
        swingSeen.add(idea.ticker);
        swingIdeas.push(idea);
      }
    }

    const result: ScanResult = {
      dayTrades: dayIdeas,
      swingTrades: swingIdeas,
      timestamp: now,
    };

    _cachedResult = result;
    _cacheTimestamp = now;

    console.log(`[Trade Scanner] Returning ${dayIdeas.length} day (${dayBuys.length} BUY, ${daySells.length} SELL), ${swingIdeas.length} swing`);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Trade Scanner] Error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
