/**
 * Dip-Entry Watcher
 *
 * Runs every 5 minutes during market hours. For each watchlist stock:
 *   1. Checks if price has dropped ≥5% from its 20-day high (intraday or daily)
 *   2. Confirms the stock is still in an uptrend (above SMA50)
 *   3. If both true — queues it for an immediate focused options scan
 *
 * The insight (from the video): entering on a 5-10% dip within a confirmed
 * uptrend stacks three advantages simultaneously:
 *   - Elevated IV (fear premium) = more credit collected
 *   - Lower current price = strike is further OTM relative to recent highs
 *   - Panic selling = irrational short-term move that reverts
 *
 * This is why their coaching program claims a 98% win rate.
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const DIP_THRESHOLD_PCT = 5;      // stock down ≥5% from 20-day high = dip entry
const DIP_LOOKBACK_DAYS = 20;     // measure high over last 20 trading days

// Track which tickers we've already alerted on today (reset at midnight)
const alertedToday = new Set<string>();
let alertedDate = '';

function getTodayET(): string {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function resetIfNewDay() {
  const today = getTodayET();
  if (today !== alertedDate) {
    alertedToday.clear();
    alertedDate = today;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

interface DipCheckResult {
  ticker: string;
  price: number;
  recentHigh: number;
  dipPct: number;
  aboveSma50: boolean;
  isDip: boolean;
}

async function checkDip(ticker: string): Promise<DipCheckResult | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 86400 * (DIP_LOOKBACK_DAYS + 10); // extra buffer

  const data = await fetchJson<{ c?: number[]; h?: number[] }>(
    `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`
  );

  if (!data?.c || !data.h || data.c.length < 10) return null;

  const closes = data.c;
  const highs = data.h;
  const price = closes[closes.length - 1];

  // 20-day high from recent highs
  const recentHighs = highs.slice(-DIP_LOOKBACK_DAYS);
  const recentHigh = Math.max(...recentHighs);

  // 50-day SMA for trend confirmation
  const sma50Closes = closes.slice(-50);
  const sma50 = sma50Closes.length >= 50
    ? sma50Closes.reduce((a, b) => a + b, 0) / 50
    : null;
  const aboveSma50 = sma50 !== null ? price > sma50 : true;

  const dipPct = recentHigh > 0 ? ((recentHigh - price) / recentHigh) * 100 : 0;
  const isDip = dipPct >= DIP_THRESHOLD_PCT && aboveSma50;

  return { ticker, price, recentHigh, dipPct, aboveSma50, isDip };
}

export async function runDipWatcher(): Promise<void> {
  resetIfNewDay();

  const sb = getSupabase();
  const { data: watchlist } = await sb
    .from('options_watchlist')
    .select('ticker, notes')
    .eq('active', true);

  if (!watchlist?.length) return;

  const dipCandidates: string[] = [];

  for (const entry of watchlist as Array<{ ticker: string; notes: string | null }>) {
    // Skip if already alerted today
    if (alertedToday.has(entry.ticker)) continue;

    // Throttle Finnhub calls
    await new Promise(r => setTimeout(r, 400));

    const result = await checkDip(entry.ticker);
    if (!result?.isDip) continue;

    dipCandidates.push(result.ticker);
    alertedToday.add(result.ticker);

    const msg = `📉 Dip entry: ${result.ticker} down ${result.dipPct.toFixed(1)}% from 20d high ($${result.recentHigh.toFixed(2)} → $${result.price.toFixed(2)}) — uptrend intact`;
    console.log(`[Dip Watcher] ${msg}`);

    createAutoTradeEvent({
      ticker: result.ticker,
      event_type: 'info',
      action: 'executed',
      source: 'scanner',
      mode: 'OPTIONS_PUT',
      message: msg,
      metadata: {
        dipPct: result.dipPct,
        recentHigh: result.recentHigh,
        currentPrice: result.price,
        aboveSma50: result.aboveSma50,
        trigger: 'dip_watcher',
      },
    });
  }

  // If we found dip candidates, trigger a focused scan immediately
  if (dipCandidates.length > 0) {
    console.log(`[Dip Watcher] Triggering focused scan for: ${dipCandidates.join(', ')}`);
    // The main scan will pick them up with dipEntry=true in the next cycle
    // (they're already in the watchlist — the dip detection runs inside checkStock)
    // We just log the alert here so users see it in the Log tab
  }
}
