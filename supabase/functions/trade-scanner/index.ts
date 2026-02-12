// Portfolio Assistant — Trade Scanner Edge Function
//
// Scans market movers + a curated universe to find the best day trade
// and swing trade candidates. Returns only HIGH-CONFIDENCE setups.
//
// NO Gemini / AI calls — pure data + scoring. Fast and cheap.
// Full AI analysis happens when the user clicks a pick on the frontend.
//
// Data flow:
//   Yahoo Finance screener  → day trade candidates (top gainers with volume)
//   Yahoo Finance batch quote → swing trade candidates (pullbacks in uptrends)
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
  score: number;        // 0-100 (only 60+ returned — high confidence)
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
// ~50 liquid, well-known names. Swing trading needs liquidity + clear trends.

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
    if (!res.ok) {
      console.warn(`[Trade Scanner] Yahoo movers ${type} returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data?.finance?.result?.[0]?.quotes ?? [];
  } catch (e) {
    console.warn(`[Trade Scanner] Movers fetch failed:`, e);
    return [];
  }
}

async function fetchBatchQuotes(symbols: string[]): Promise<YahooQuote[]> {
  if (symbols.length === 0) return [];
  try {
    // Yahoo batch quote endpoint — one call for all symbols
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) {
      console.warn(`[Trade Scanner] Yahoo batch quote returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data?.quoteResponse?.result ?? [];
  } catch (e) {
    console.warn(`[Trade Scanner] Batch quote failed:`, e);
    return [];
  }
}

// ── Day Trade Scoring ───────────────────────────────────
// High confidence = strong momentum + confirmed by volume + tradeable price.
// Minimum score to surface: 60/100.

function scoreDayTrade(q: YahooQuote): TradeIdea | null {
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
  let score = 0;
  const tags: string[] = [];
  const reasons: string[] = [];

  // ── 1. Change% (max 30 pts) — sweet spot is 3-15%
  if (absPct >= 4 && absPct <= 10) { score += 30; }
  else if (absPct > 10 && absPct <= 20) { score += 25; }
  else if (absPct >= 3 && absPct < 4) { score += 22; }
  else if (absPct > 20 && absPct <= 40) { score += 15; }
  else if (absPct >= 2) { score += 12; }
  else return null; // < 2% change = not enough momentum for day trade

  if (absPct >= 5) tags.push('momentum');

  // ── 2. Volume confirmation (max 30 pts) — THE key filter
  // Without volume, momentum means nothing.
  let volRatio = 0;
  if (avgVolume > 0) {
    volRatio = volume / avgVolume;
    if (volRatio >= 4) { score += 30; tags.push('volume-surge'); reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
    else if (volRatio >= 2.5) { score += 26; tags.push('high-volume'); reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
    else if (volRatio >= 1.5) { score += 20; reasons.push(`Vol ${round(volRatio, 1)}x avg`); }
    else if (volRatio >= 1) { score += 10; }
    else { score += 2; } // below-avg volume = low conviction
  } else if (volume > 2_000_000) {
    score += 12;
  } else {
    score += 2;
  }

  // ── 3. Price range (max 15 pts) — tradeable, liquid names
  if (price >= 10 && price <= 200) score += 15;
  else if (price >= 5 && price < 10) score += 8;
  else if (price > 200 && price <= 500) score += 12;
  else if (price > 500) score += 8;
  else score += 0; // sub-$5 = risky

  // ── 4. Intraday range (max 15 pts) — room to move
  if (high > 0 && low > 0 && price > 0) {
    const rangePct = ((high - low) / price) * 100;
    if (rangePct > 6) { score += 15; tags.push('wide-range'); }
    else if (rangePct > 4) { score += 12; }
    else if (rangePct > 2) { score += 8; }
    else { score += 3; }
  }

  // ── 5. Gap factor (max 10 pts) — gaps with volume = institutional interest
  if (prevClose > 0 && open > 0) {
    const gapPct = ((open - prevClose) / prevClose) * 100;
    if (Math.abs(gapPct) > 4) { score += 10; tags.push('gap'); reasons.push(`Gapped ${gapPct > 0 ? '+' : ''}${round(gapPct, 1)}%`); }
    else if (Math.abs(gapPct) > 2) { score += 6; }
  }

  // Build reason string
  const direction = changePct > 0 ? 'Up' : 'Down';
  const mainReason = `${direction} ${round(absPct, 1)}%`;
  const extra = reasons.length > 0 ? ` · ${reasons.join(' · ')}` : '';

  return {
    ticker: q.symbol,
    name: q.shortName ?? q.longName ?? q.symbol,
    price: round(price),
    change: round(change),
    changePercent: round(changePct, 1),
    score: Math.min(100, score),
    reason: `${mainReason}${extra}`,
    tags,
    mode: 'DAY_TRADE',
  };
}

// ── Swing Trade Scoring ─────────────────────────────────
// High confidence = pullback in a confirmed uptrend + near support.
// We want "buy the dip on a strong stock", not "catch a falling knife".

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

  // ── 1. Uptrend confirmation (max 30 pts) — MUST be in an uptrend
  // Price above both SMA50 and SMA200 = confirmed uptrend.
  // Without this, a pullback is just… a downtrend.
  const aboveSma50 = sma50 > 0 && price > sma50;
  const aboveSma200 = sma200 > 0 && price > sma200;
  const sma50Above200 = sma50 > 0 && sma200 > 0 && sma50 > sma200;

  if (aboveSma50 && aboveSma200 && sma50Above200) {
    score += 30; tags.push('strong-uptrend');
  } else if (aboveSma50 && aboveSma200) {
    score += 24; tags.push('uptrend');
  } else if (aboveSma200 && !aboveSma50) {
    // Below SMA50 but above SMA200 — possible pullback zone, interesting
    score += 18; tags.push('pullback-zone');
  } else if (aboveSma50 && !aboveSma200) {
    score += 10; // recovering but not confirmed
  } else {
    score += 0; // below both MAs = likely downtrend, not a swing long
  }

  // ── 2. Pullback quality (max 25 pts) — we want a dip, not a crash
  if (changePct <= -1 && changePct > -4) {
    score += 25; tags.push('pullback'); reasons.push(`Dipped ${round(Math.abs(changePct), 1)}%`);
  } else if (changePct <= -4 && changePct > -8) {
    score += 20; tags.push('pullback'); reasons.push(`Dipped ${round(Math.abs(changePct), 1)}%`);
  } else if (changePct <= -8 && changePct > -12) {
    score += 12; tags.push('sell-off'); reasons.push(`Sold off ${round(Math.abs(changePct), 1)}%`);
  } else if (changePct <= -12) {
    score += 5; tags.push('crash'); // catching a falling knife — low confidence
  } else if (changePct < 0) {
    score += 15; // mild red day
  } else {
    score += 3; // green day — not ideal entry timing for swing
  }

  // ── 3. Proximity to SMA50 support (max 20 pts)
  // The closer to SMA50 from above, the better the risk/reward.
  if (sma50 > 0) {
    const distPct = ((price - sma50) / sma50) * 100;
    if (distPct >= 0 && distPct <= 2) {
      score += 20; tags.push('at-sma50'); reasons.push('At SMA(50) support');
    } else if (distPct >= -2 && distPct < 0) {
      score += 18; tags.push('testing-sma50'); reasons.push('Testing SMA(50)');
    } else if (distPct > 2 && distPct <= 5) {
      score += 12; // above SMA50 but not at support yet
    } else if (distPct > 5 && distPct <= 10) {
      score += 6; // well above support — might have more to fall
    } else if (distPct > 10) {
      score += 2; // extended above SMA50 — not a buy-the-dip setup
    } else {
      score += 5; // below SMA50 by more than 2%
    }
  }

  // ── 4. 52-week range position (max 15 pts) — upper half = healthy trend
  if (high52 > 0 && low52 > 0 && high52 > low52) {
    const position = (price - low52) / (high52 - low52);
    const pctFromHigh = round((1 - position) * 100, 0);
    if (position >= 0.8) {
      score += 15; reasons.push(`${pctFromHigh}% from 52w high`);
    } else if (position >= 0.65) {
      score += 12; reasons.push(`${pctFromHigh}% from 52w high`);
    } else if (position >= 0.5) {
      score += 8;
    } else {
      score += 2; // lower half of range — bearish context
    }
  }

  // ── 5. Volume on pullback (max 10 pts) — quiet pullbacks are healthy
  if (avgVolume > 0 && volume > 0 && changePct < 0) {
    const volRatio = volume / avgVolume;
    if (volRatio < 0.7) {
      score += 10; tags.push('quiet-dip'); reasons.push('Low-vol pullback');
    } else if (volRatio < 1) {
      score += 7;
    } else if (volRatio > 2) {
      score -= 5; // heavy selling = institutional distribution, be cautious
    }
  }

  const reasonStr = reasons.length > 0 ? reasons.join(' · ') : `${round(changePct, 1)}% today`;

  return {
    ticker: q.symbol,
    name: q.shortName ?? q.longName ?? q.symbol,
    price: round(price),
    change: round(change),
    changePercent: round(changePct, 1),
    score: Math.max(0, Math.min(100, score)),
    reason: reasonStr,
    tags,
    mode: 'SWING_TRADE',
  };
}

// ── In-memory cache ─────────────────────────────────────
// Scanner results are stable intraday — cache 10 min.

let _cachedResult: ScanResult | null = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

// ── Main handler ────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Parse optional portfolio tickers from request
    let portfolioTickers: string[] = [];
    try {
      const body = await req.json();
      if (Array.isArray(body?.portfolioTickers)) {
        portfolioTickers = body.portfolioTickers
          .map((t: unknown) => String(t).trim().toUpperCase())
          .filter((t: string) => t.length > 0 && t.length <= 10);
      }
    } catch {
      // No body or invalid JSON — that's fine
    }

    // Check cache
    const now = Date.now();
    if (_cachedResult && now - _cacheTimestamp < CACHE_TTL_MS) {
      console.log('[Trade Scanner] Serving cached results');
      return new Response(JSON.stringify({ ..._cachedResult, cached: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[Trade Scanner] Scanning... (${portfolioTickers.length} portfolio tickers)`);

    // ── Fetch data in parallel ──
    // Day trades: top gainers from Yahoo (comes with volume, change, etc.)
    // Swing trades: batch quotes for curated universe + portfolio tickers
    const swingSymbols = [...new Set([...SWING_UNIVERSE, ...portfolioTickers])];

    const [gainers, swingQuotes] = await Promise.all([
      fetchMovers('day_gainers'),
      fetchBatchQuotes(swingSymbols),
    ]);

    console.log(`[Trade Scanner] Got ${gainers.length} gainers, ${swingQuotes.length} swing quotes`);

    // ── Score day trades — only surface score >= 55 (high confidence) ──
    const dayIdeas: TradeIdea[] = gainers
      .map(scoreDayTrade)
      .filter((x): x is TradeIdea => x !== null && x.score >= 55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    // ── Score swing trades — only surface score >= 50 (confirmed uptrend + pullback) ──
    const swingIdeas: TradeIdea[] = swingQuotes
      .map(scoreSwingTrade)
      .filter((x): x is TradeIdea => x !== null && x.score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const result: ScanResult = {
      dayTrades: dayIdeas,
      swingTrades: swingIdeas,
      timestamp: now,
    };

    // Cache
    _cachedResult = result;
    _cacheTimestamp = now;

    console.log(`[Trade Scanner] Returning ${dayIdeas.length} day trades, ${swingIdeas.length} swing trades`);

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
