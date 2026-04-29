/**
 * Weekly Watchlist Screener
 *
 * Runs every Monday morning and screens a broad candidate universe for
 * options wheel suitability. Auto-promotes the top picks directly into
 * `options_watchlist` — no manual review required. Results are also
 * recorded in `options_watchlist_candidates` for audit history.
 *
 * The main options-scanner acts as the real quality gate at trade time
 * (IV rank, options chain validity, earnings blackout, etc.), so adding
 * a ticker to the watchlist just means "consider this each scan cycle".
 *
 * Screening criteria:
 *   1. Market cap ≥ $5B (large enough for liquid options chain)
 *   2. Stock price $15–$2000 (avoids penny stocks + very high-priced names)
 *   3. Beta 0.3–2.8 (not too sleepy, not too wild)
 *   4. Not already in the watchlist
 *
 * Tier auto-assigned by beta:
 *   beta < 0.9  → STABLE
 *   beta 0.9–1.5 → GROWTH
 *   beta > 1.5  → HIGH_VOL
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';

// Curated universe of S&P 500 / Nasdaq 100 candidates beyond what's already on the watchlist.
// Covers dividend aristocrats, large-cap tech, quality growth, and high-IV momentum names.
const CANDIDATE_UNIVERSE = [
  // Dividend Aristocrats / Stable Blue-chips
  'JNJ', 'PG', 'KMB', 'MCD', 'MMM', 'PEP', 'CL', 'CVX', 'XOM', 'WMT',
  'T', 'VZ', 'SO', 'DUK', 'NEE', 'BRK.B', 'GS', 'MS', 'C', 'WFC',
  'TGT', 'LOW', 'AXP', 'BAC', 'USB', 'PFE', 'MRK', 'ABT', 'TMO', 'UNP',
  // Large-cap Tech / Quality Growth
  'ADBE', 'CRM', 'NOW', 'SHOP', 'SQ', 'PYPL', 'UBER', 'LYFT', 'ZM', 'DOCU',
  'NET', 'CRWD', 'OKTA', 'SNOW', 'MDB', 'ZS', 'FTNT', 'SPLK', 'WDAY', 'VEEV',
  'INTC', 'QCOM', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'ON', 'SWKS', 'MPWR',
  'AMGN', 'GILD', 'BIIB', 'REGN', 'VRTX', 'ISRG', 'MDT', 'SYK', 'BSX', 'EW',
  // High-IV Momentum
  'MSTR', 'COIN', 'HOOD', 'SOFI', 'UPST', 'AFRM', 'RIVN', 'LCID', 'NIO', 'XPEV',
  'ARM', 'SMCI', 'DELL', 'HPQ', 'STX', 'WDC', 'MU', 'GFS', 'UMC',
  // ETFs with good options liquidity
  'SPY', 'QQQ', 'IWM', 'XLF', 'XLE', 'XLK', 'XLV', 'XLU', 'GLD', 'SLV',
  'EEM', 'FXI', 'KWEB', 'ARKK', 'ARKW', 'TLT', 'HYG', 'LQD',
];

interface FinnhubMetric {
  metric?: {
    beta?: number;
    '52WeekHigh'?: number;
    '52WeekLow'?: number;
    marketCapitalization?: number;
  };
}

interface FinnhubQuote {
  c?: number; // current price
}

interface FinnhubProfile {
  name?: string;
  finnhubIndustry?: string;
  exchange?: string;
}

let _lastCall = 0;
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const wait = 900 - (Date.now() - _lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

function assignTier(beta: number): 'STABLE' | 'GROWTH' | 'HIGH_VOL' {
  if (beta < 0.9) return 'STABLE';
  if (beta <= 1.5) return 'GROWTH';
  return 'HIGH_VOL';
}

export interface WatchlistCandidate {
  ticker: string;
  name: string;
  price: number;
  beta: number;
  marketCapB: number; // billions
  high52w: number;
  low52w: number;
  pctFrom52wHigh: number;
  tier: 'STABLE' | 'GROWTH' | 'HIGH_VOL';
  industry: string;
  reason: string;
}

export async function runWatchlistScreener(): Promise<void> {
  const sb = getSupabase();
  console.log('[Watchlist Screener] Starting weekly candidate scan...');

  // Load existing watchlist tickers to exclude them
  const { data: existing } = await sb
    .from('options_watchlist')
    .select('ticker');
  const existingSet = new Set((existing ?? []).map((r: { ticker: string }) => r.ticker.toUpperCase()));

  const candidates: WatchlistCandidate[] = [];
  const skipped: string[] = [];

  for (const ticker of CANDIDATE_UNIVERSE) {
    if (existingSet.has(ticker.toUpperCase())) {
      skipped.push(`${ticker}: already_in_watchlist`);
      continue;
    }

    const [metrics, quote, profile] = await Promise.all([
      fetchJson<FinnhubMetric>(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`),
      fetchJson<FinnhubQuote>(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`),
      fetchJson<FinnhubProfile>(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`),
    ]);

    const beta = metrics?.metric?.beta ?? null;
    const high52w = metrics?.metric?.['52WeekHigh'] ?? null;
    const low52w = metrics?.metric?.['52WeekLow'] ?? null;
    const marketCap = metrics?.metric?.marketCapitalization ?? null; // in millions
    const price = quote?.c ?? null;

    // Gate 1: must have data
    if (!beta || !price || !high52w || !low52w || !marketCap) {
      skipped.push(`${ticker}: missing_data`);
      continue;
    }

    // Gate 2: market cap ≥ $5B
    if (marketCap < 5_000) {
      skipped.push(`${ticker}: small_cap_${(marketCap / 1000).toFixed(1)}B`);
      continue;
    }

    // Gate 3: price between $15 and $2000
    if (price < 15 || price > 2000) {
      skipped.push(`${ticker}: price_out_of_range_${price.toFixed(0)}`);
      continue;
    }

    // Gate 4: beta between 0.3 and 2.8
    if (beta < 0.3 || beta > 2.8) {
      skipped.push(`${ticker}: beta_out_of_range_${beta.toFixed(2)}`);
      continue;
    }

    const pctFrom52wHigh = ((high52w - price) / high52w) * 100;
    const tier = assignTier(beta);
    const marketCapB = marketCap / 1000;

    // Build reason string
    const reasons: string[] = [];
    if (tier === 'STABLE') reasons.push('stable blue-chip');
    if (tier === 'GROWTH') reasons.push('quality growth');
    if (tier === 'HIGH_VOL') reasons.push('high-IV momentum');
    if (pctFrom52wHigh > 15) reasons.push(`${pctFrom52wHigh.toFixed(0)}% off 52w high — dip entry`);
    if (marketCapB > 100) reasons.push('mega-cap liquidity');

    candidates.push({
      ticker: ticker.toUpperCase(),
      name: profile?.name ?? ticker,
      price,
      beta,
      marketCapB,
      high52w,
      low52w,
      pctFrom52wHigh,
      tier,
      industry: profile?.finnhubIndustry ?? 'Unknown',
      reason: reasons.join(', '),
    });
  }

  // Sort by tier preference (STABLE first, then GROWTH, then HIGH_VOL) then by dip depth
  const tierOrder = { STABLE: 0, GROWTH: 1, HIGH_VOL: 2 };
  candidates.sort((a, b) =>
    tierOrder[a.tier] - tierOrder[b.tier] || b.pctFrom52wHigh - a.pctFrom52wHigh
  );

  // Top 20 candidates
  const top = candidates.slice(0, 20);
  const now = new Date().toISOString();

  if (top.length > 0) {
    // 1. Record in candidates table for audit history (dismissed=true = already handled)
    const candidateRows = top.map(c => ({
      ticker: c.ticker,
      name: c.name,
      price: c.price,
      beta: c.beta,
      market_cap_b: c.marketCapB,
      high_52w: c.high52w,
      low_52w: c.low52w,
      pct_from_52w_high: c.pctFrom52wHigh,
      tier: c.tier,
      industry: c.industry,
      reason: c.reason,
      scanned_at: now,
      dismissed: true,   // auto-promoted — no manual action needed
      added_at: now,
    }));
    await sb.from('options_watchlist_candidates').upsert(candidateRows, { onConflict: 'ticker' });

    // 2. Auto-promote directly to options_watchlist (skip tickers already there)
    const watchlistRows = top.map(c => ({
      ticker: c.ticker,
      active: true,
      notes: c.reason,
      tier: c.tier,
    }));
    await sb.from('options_watchlist').upsert(watchlistRows, { onConflict: 'ticker', ignoreDuplicates: true });

    console.log(`[Watchlist Screener] Auto-promoted ${top.length} tickers to options_watchlist.`);
    top.forEach(c => console.log(`  ✅ ${c.ticker} (${c.tier}) — $${c.price.toFixed(0)}, beta ${c.beta.toFixed(2)}, ${c.pctFrom52wHigh.toFixed(0)}% off high — ${c.reason}`));
  }

  console.log(`[Watchlist Screener] Done. ${top.length} added, ${skipped.length} skipped.`);

  await createAutoTradeEvent({
    action: 'scan_complete',
    source: 'watchlist_screener',
    metadata: {
      auto_promoted: top.length,
      skipped: skipped.length,
      top5: top.slice(0, 5).map(c => c.ticker),
    },
  });
}
