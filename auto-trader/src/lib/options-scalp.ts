/**
 * Options Scalp — Kaycapitals ATM directional options strategy.
 *
 * Strategy (intraday, same-day exit):
 *   - Stock moves >1.5% from today's open → momentum signal confirmed
 *   - Up: buy ATM call.  Down: buy ATM put.
 *   - ATM = closest whole-dollar strike to current price (~0.40–0.60 delta)
 *   - Limit order at ask price (or market if spread < 3%)
 *   - Nearest weekly expiry (current or next Friday, at least 1 day out)
 *   - Exit rules:
 *       • 100% profit (premium doubles) → take profit
 *       • 50% loss (premium halves) → stop out
 *       • 3:45 PM ET → forced EOD close
 *   - Max 2 scalp trades per day, 1 contract each, $500 max premium per trade
 *
 * This is SEPARATE from the wheel (OPTIONS_PUT/OPTIONS_CALL) — that strategy
 * SELLS options to collect premium over weeks. This strategy BUYS options to
 * profit from same-day directional moves.
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { isConnected, placeOptionsOrder, cancelOrder, getDefaultAccount } from '../ib-connection.js';
import { findAtmStrike, getOptionGreeksForContract } from './options-chain.js';
import { fetchQuote, fetchIntradayBars, fetchDailyBars, type IntradayBar } from './yahoo-finance.js';
import { detectVwapReclaim, fetchVwap, VWAP_RELIABLE_HOUR_ET } from './vwap.js';

// ── Constants ────────────────────────────────────────────
const MAX_SCALP_TRADES_PER_DAY = 5;
const MAX_PREMIUM_PER_TRADE = 1_500;     // max $1,500 total premium for the trade (2 contracts × ask × 100). If 2 contracts exceed this, skip — never fall back to 1.
const MAX_CONTRACTS = 2;                 // 2 contracts enables partial exits (sell 1 at first target, runner to break-even)
const PARTIAL_TARGET_MULT = 1.5;         // sell 1st contract when premium up 50%, move stop on runner to break-even
const PROFIT_TARGET_MULT = 2.0;          // close all remaining when premium doubles
const STOP_LOSS_MULT = 0.50;             // close all when premium halves (only before first partial)
const MAX_SPREAD_MARKET_ORDER_PCT = 3;   // use market order only if spread < 3% of mid
const LAST_ENTRY_HOUR_ET = 11;           // no new scalp entries after 11:00 AM ET (90-minute rule)
const LAST_ENTRY_MIN_ET  = 0;
const ORB_END_HOUR_ET    = 9;            // ORB forms during 9:30–9:45; no entries before 9:45
const ORB_END_MIN_ET     = 45;
const ORB_RETEST_BUFFER_PCT = 0.0015;   // retest buffer = 0.15% of ORB level (relative, not absolute)
                                        // SPY $752 → $1.13, TSLA $280 → $0.42, AMD $130 → $0.20
                                        // Was $0.15 fixed — at SPY $750 that's 0.02%, impossibly tight for 5-min bars
const ORB_SMA200_PERIOD  = 200;          // 200-period SMA on 5-min bars — Kay Capitals direction filter (needs 5d range)

// ── NTZ / ORB helpers ────────────────────────────────────

/**
 * Fetch No-Trading-Zone boundaries for a ticker.
 * NTZ = box formed by max(premarket_high, yesterday_high) and min(premarket_low, yesterday_low).
 * Returns null if data is unavailable.
 */
async function fetchNtz(ticker: string): Promise<{ ntzTop: number; ntzBottom: number } | null> {
  const [preBars, dailyBars] = await Promise.all([
    fetchIntradayBars(ticker, '5m', '1d', true),   // pre-market data included
    fetchDailyBars(ticker, '5d'),
  ]);

  // Pre-market high/low: bars before 9:30 AM ET (Unix: today 13:30 UTC)
  if (!preBars?.length) return null;
  const todayEt = new Date();
  const marketOpenUtc = new Date();
  marketOpenUtc.setUTCHours(13, 30, 0, 0); // 9:30 AM ET = 13:30 UTC
  const preMarketBars = preBars.filter(b => b.timestamp * 1000 < marketOpenUtc.getTime());
  if (!preMarketBars.length) return null;

  const preHigh = Math.max(...preMarketBars.map(b => b.high));
  const preLow  = Math.min(...preMarketBars.map(b => b.low));

  // Yesterday's high/low from daily bars
  if (!dailyBars?.length || dailyBars.length < 2) return null;
  const todayDateStr = todayEt.toISOString().slice(0, 10).replace(/-/g, '');
  const yesterday = dailyBars.filter(b => b.date < todayDateStr).at(-1);
  if (!yesterday) return null;

  const ntzTop    = Math.max(preHigh, yesterday.high);
  const ntzBottom = Math.min(preLow,  yesterday.low);

  return { ntzTop, ntzBottom };
}

/**
 * Calculate the ORB (Opening Range Breakout) for a ticker.
 * ORB = high and low of the first 15 minutes of market open (9:30–9:45 AM ET).
 * Returns null if not enough bars.
 */
async function fetchOrb(ticker: string): Promise<{ orbHigh: number; orbLow: number } | null> {
  const bars = await fetchIntradayBars(ticker, '5m', '1d', false);
  if (!bars?.length) return null;

  // 9:30–9:45 AM ET = 13:30–13:45 UTC
  const orbStart = new Date();
  orbStart.setUTCHours(13, 30, 0, 0);
  const orbEnd = new Date();
  orbEnd.setUTCHours(13, 45, 0, 0);

  const orbBars = bars.filter(b => {
    const ts = b.timestamp * 1000;
    return ts >= orbStart.getTime() && ts < orbEnd.getTime();
  });
  if (orbBars.length < 2) return null; // need at least 2 5-min bars (9:30 and 9:35)

  return {
    orbHigh: Math.max(...orbBars.map(b => b.high)),
    orbLow:  Math.min(...orbBars.map(b => b.low)),
  };
}

/**
 * Detect ORB breakout + retest setup on 5-min bars.
 *
 * Returns direction ('C' for calls if broke above, 'P' for puts if broke below)
 * and whether the current price is retesting the ORB level with low volume.
 *
 * Kay's "sexy ORB" rule:
 *  1. Wait for 2 independent candles to fully close above/below ORB (no part touching the line)
 *  2. Then price comes back and retests the ORB level
 *  3. Retest candle volume < breakout candle volume (otherwise it's a trap)
 *  4. Enter on the NEXT candle after the retest
 */
function detectOrbSetup(
  bars: IntradayBar[],
  orb: { orbHigh: number; orbLow: number },
  currentPrice: number,
  ticker?: string,
): { direction: 'C' | 'P'; breakoutVol: number; retestVol: number } | null {
  // Only look at bars after ORB formation (after 9:45 AM ET = timestamp > 13:45 UTC)
  const orbEndUtc = new Date();
  orbEndUtc.setUTCHours(13, 45, 0, 0);
  const postOrbBars = bars.filter(b => b.timestamp * 1000 >= orbEndUtc.getTime());
  if (postOrbBars.length < 3) return null;

  // Compute relative retest buffers (0.15% of ORB level)
  const retestBufHigh = orb.orbHigh * ORB_RETEST_BUFFER_PCT;
  const retestBufLow  = orb.orbLow  * ORB_RETEST_BUFFER_PCT;
  const tag = ticker ? `[Options Scalp] ${ticker}` : '[Options Scalp]';

  // Scan for 2 independent candles fully closed above orbHigh
  for (let i = 0; i <= postOrbBars.length - 3; i++) {
    const b1 = postOrbBars[i];
    const b2 = postOrbBars[i + 1];
    const b3 = postOrbBars[i + 2]; // potential retest candle

    // ── Bullish: 2 candles fully above orbHigh, then retest from above ──
    if (b1.low > orb.orbHigh && b2.low > orb.orbHigh) {
      // b3 is the retest: its low touches near orbHigh (within 0.15% of orbHigh)
      const isRetest = b3.low <= orb.orbHigh + retestBufHigh && b3.close > orb.orbHigh - retestBufHigh;
      if (isRetest) {
        const breakoutVol = Math.max(b1.volume, b2.volume);
        if (b3.volume < breakoutVol) {
          if (currentPrice > orb.orbHigh - retestBufHigh) {
            return { direction: 'C', breakoutVol, retestVol: b3.volume };
          } else {
            console.log(`${tag}: bullish ORB retest found (buf=$${retestBufHigh.toFixed(2)}) but price $${currentPrice.toFixed(2)} moved away from orbHigh $${orb.orbHigh.toFixed(2)} — missed window`);
          }
        } else {
          console.log(`${tag}: bullish ORB retest found but volume too high (retest ${b3.volume} >= breakout ${breakoutVol}) — trap signal`);
        }
      }
    }

    // ── Bearish: 2 candles fully below orbLow, then retest from below ──
    if (b1.high < orb.orbLow && b2.high < orb.orbLow) {
      const isRetest = b3.high >= orb.orbLow - retestBufLow && b3.close < orb.orbLow + retestBufLow;
      if (isRetest) {
        const breakoutVol = Math.max(b1.volume, b2.volume);
        if (b3.volume < breakoutVol) {
          if (currentPrice < orb.orbLow + retestBufLow) {
            return { direction: 'P', breakoutVol, retestVol: b3.volume };
          } else {
            console.log(`${tag}: bearish ORB retest found (buf=$${retestBufLow.toFixed(2)}) but price $${currentPrice.toFixed(2)} moved away from orbLow $${orb.orbLow.toFixed(2)} — missed window`);
          }
        } else {
          console.log(`${tag}: bearish ORB retest found but volume too high (retest ${b3.volume} >= breakout ${breakoutVol}) — trap signal`);
        }
      }
    }
  }

  return null;
}

/**
 * Compute 200-period SMA from 5-min bars — Kay Capitals direction filter.
 * Returns 'C' if price above SMA (calls only), 'P' if below (puts only), null if chopping.
 */
/**
 * SPY VWAP market regime gate.
 *
 * Historical data (Jun 2–4, 2026 — our only true 0DTE cohort):
 *   - ALL 3 winning scalps were PUTS during a downtrend week
 *   - ALL 4 losing scalps were CALLS during the same downtrend week
 *
 * Mechanism: in downtrends, VWAP reclaims are traps. Price briefly reclaims
 * VWAP, triggers the ORB/VWAP call setup, then fails as the market resumes lower.
 * Kay Capitals runs this filter by eye — we encode it explicitly.
 *
 * Rule: only take a CALL when SPY is above its daily VWAP (BULLISH regime),
 * only take a PUT when SPY is below (BEARISH). NEUTRAL (exactly at VWAP) → skip.
 *
 * Falsification threshold (per Mary/roundtable Jun 29):
 *   If after 30+ trades >40% of filter-approved entries still lose, revisit
 *   confidence-weighted approach (require magnitude / candle confirmation).
 */
export type SpyRegime = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export async function getSpyRegime(): Promise<SpyRegime> {
  const result = await fetchVwap('SPY');
  if (!result) return 'NEUTRAL';
  if (result.side === 'above') return 'BULLISH';
  if (result.side === 'below') return 'BEARISH';
  return 'NEUTRAL';
}

function get5mSmaDirection(bars: IntradayBar[], currentPrice: number): 'C' | 'P' | null {
  if (bars.length < ORB_SMA200_PERIOD) return null;
  const closes = bars.map(b => b.close);
  const sum = closes.slice(-ORB_SMA200_PERIOD).reduce((a, b) => a + b, 0);
  const sma200 = sum / ORB_SMA200_PERIOD;
  const distPct = Math.abs(currentPrice - sma200) / sma200 * 100;
  if (distPct < 0.3) return null; // within 0.3% = chopping, no edge
  return currentPrice > sma200 ? 'C' : 'P';
}

/**
 * Parse an option expiry string (YYYYMMDD or YYYY-MM-DD) to a local Date at midnight.
 * Returns null if the format is unrecognised.
 */
function parseExpiryDate(expiry: string): Date | null {
  const cleaned = expiry.replace(/-/g, '');
  if (!/^\d{8}$/.test(cleaned)) return null;
  const y = parseInt(cleaned.slice(0, 4), 10);
  const m = parseInt(cleaned.slice(4, 6), 10) - 1;
  const d = parseInt(cleaned.slice(6, 8), 10);
  return new Date(y, m, d);
}

/**
 * Return today's expiry date as YYYYMMDD — 0DTE (same-day expiration).
 *
 * Kay Capitals (Somesh) explicitly uses "same day expiration contracts on SPY."
 * 0DTE options:
 *   - SPY has daily expirations Mon–Fri so there is always a valid 0DTE chain.
 *   - Cheap premium → 100–200% moves happen in minutes when the setup is right.
 *   - Hard EOD close at 3:45 PM ensures we never hold overnight.
 *   - If IB rejects the 0DTE order (e.g. expiry no longer tradeable), executeScalp
 *     returns false and the trade is skipped — no fallback to weekly.
 *
 * Previous implementation picked "next Friday at least 1 day out" which meant
 * we were buying expensive multi-day options. When the EOD close failed (pre-Jun-5
 * fix) those held overnight and expired worthless. Even with the EOD close working,
 * multi-day options require a larger move to double, reducing win rate.
 */
/**
 * Return the nearest weekly Friday expiry as YYYYMMDD.
 * All tickers — ETFs and individual stocks — have listed Friday options,
 * so this is the only expiry format guaranteed to resolve in IB for any ticker.
 * On Fridays this is 0DTE; otherwise it is the upcoming Friday (1–4 DTE).
 */
function getNearestFridayExpiry(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = nowET.getDay(); // 0=Sun … 5=Fri
  const daysUntilFriday = dow === 5 ? 0 : (5 - dow + 7) % 7;
  const friday = new Date(nowET);
  friday.setDate(nowET.getDate() + daysUntilFriday);
  const y  = friday.getFullYear();
  const mo = String(friday.getMonth() + 1).padStart(2, '0');
  const d  = String(friday.getDate()).padStart(2, '0');
  return `${y}${mo}${d}`;
}

function getTodayExpiry(): string {
  // Always use TODAY's date for true 0DTE. Tickers without a same-day chain
  // (most individual stocks on Mon–Thu) will get IB code-200 and be skipped.
  // ETFs (SPY, QQQ, IWM) and mega-caps have daily chains every session.
  // NEVER fall back to next Friday — that produces multi-day options, not scalps.
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y  = nowET.getFullYear();
  const mo = String(nowET.getMonth() + 1).padStart(2, '0');
  const d  = String(nowET.getDate()).padStart(2, '0');
  return `${y}${mo}${d}`;
}

// ── Scan ─────────────────────────────────────────────────

/**
 * Main entry point — called by the scheduler at 10:00 AM and 11:00 AM ET.
 * Scans HIGH_VOL options watchlist tickers for intraday momentum, then buys
 * the ATM call (bullish) or ATM put (bearish) when conditions are met.
 */
export async function runOptionScalpScan(): Promise<void> {
  const sb = getSupabase();
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = nowET.getHours();
  const etMin  = nowET.getMinutes();

  // Wait for ORB to form — no entries before 9:45 AM ET
  if (etHour < ORB_END_HOUR_ET || (etHour === ORB_END_HOUR_ET && etMin < ORB_END_MIN_ET)) {
    console.log('[Options Scalp] Before 9:45 AM ET — waiting for ORB to form');
    return;
  }

  // 90-minute rule: no new entries after 11:00 AM ET
  if (etHour > LAST_ENTRY_HOUR_ET || (etHour === LAST_ENTRY_HOUR_ET && etMin >= LAST_ENTRY_MIN_ET)) {
    console.log('[Options Scalp] Past 11:00 AM ET — no new entries (90-min rule)');
    return;
  }

  // Guard: IB must be connected to get live chain data
  if (!isConnected()) {
    console.log('[Options Scalp] IB not connected — skipping scan');
    return;
  }

  // Daily cap check — only count trades that actually filled or are still live.
  // CANCELLED/REJECTED trades (e.g. IB code-200 rejections) must not consume a slot —
  // a failed order attempt is not a trade. Also exclude ib_reconciliation_cover records.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: todayTrades } = await sb
    .from('paper_trades')
    .select('id')
    .eq('mode', 'OPTIONS_SCALP')
    .neq('close_reason', 'ib_reconciliation_cover')
    .not('status', 'in', '(CANCELLED,REJECTED,EXPIRED)')
    .gte('opened_at', todayStart.toISOString());
  const usedToday = (todayTrades ?? []).length;
  if (usedToday >= MAX_SCALP_TRADES_PER_DAY) {
    console.log(`[Options Scalp] Daily cap reached (${usedToday}/${MAX_SCALP_TRADES_PER_DAY})`);
    return;
  }

  // Load HIGH_VOL options watchlist tickers
  // On Mon–Thu only ETFs have daily chains → restrict to ETF-only universe to avoid
  // burning premium on individual stocks that only have Friday weekly expiry.
  // On Fridays every ticker has a 0DTE chain, so run the full watchlist.
  const isFriday = nowET.getDay() === 5;
  const { data: watchlistRaw } = await sb
    .from('options_watchlist')
    .select('ticker')
    .eq('active', true)
    .eq('tier', 'HIGH_VOL');
  if (!watchlistRaw?.length) return;

  const watchlist = isFriday
    ? watchlistRaw
    : watchlistRaw.filter(({ ticker }) => VWAP_ETF_ONLY_UNIVERSE.includes(ticker));

  if (!watchlist.length) {
    console.log(`[Options Scalp] ORB scan: no ETF tickers in HIGH_VOL watchlist (Mon–Thu ETF-only mode) — skipping`);
    return;
  }

  const expiry = getTodayExpiry();
  const slotsLeft = MAX_SCALP_TRADES_PER_DAY - usedToday;

  console.log(`[Options Scalp] Scanning ${watchlist.length} ${isFriday ? 'HIGH_VOL' : 'ETF-only'} tickers (${isFriday ? 'full watchlist — Fri' : 'Mon–Thu ETF-only'}) | expiry ${expiry} | slots ${slotsLeft}`);

  let placed = 0;
  for (const { ticker } of watchlist) {
    if (placed >= slotsLeft) break;

    // Skip if already in an open scalp trade for this ticker today
    const { data: existing } = await sb
      .from('paper_trades')
      .select('id')
      .eq('mode', 'OPTIONS_SCALP')
      .eq('ticker', ticker)
      .in('status', ['SUBMITTED', 'FILLED', 'PARTIAL'])
      .gte('opened_at', todayStart.toISOString());
    if (existing?.length) continue;

    // ── Get quote + 5-min bars ───────────────────────────────────────────────
    const [q, bars5m] = await Promise.all([
      fetchQuote(ticker),
      fetchIntradayBars(ticker, '5m', '5d'),  // 5d = ~390 bars; Kay Capitals 200-period SMA requires ≥200 bars
    ]);
    if (!q?.price || !bars5m?.length) {
      console.log(`[Options Scalp] ${ticker}: data unavailable (quote=${q?.price ?? 'null'}, bars=${bars5m?.length ?? 'null'})`);
      continue;
    }
    const price = q.price;

    // ── 200 SMA direction filter (Kay Capitals) ─────────────────────────────
    const smaDirection = get5mSmaDirection(bars5m, price);
    if (smaDirection === null) {
      console.log(`[Options Scalp] ${ticker}: price $${price.toFixed(2)} chopping around 200 SMA (${bars5m.length} bars) — no edge, skipping`);
      continue;
    }

    // ── NTZ filter ───────────────────────────────────────────────────────────
    const ntz = await fetchNtz(ticker);
    if (ntz) {
      const insideNtz = price > ntz.ntzBottom && price < ntz.ntzTop;
      if (insideNtz) {
        console.log(`[Options Scalp] ${ticker}: price $${price.toFixed(2)} inside NTZ ($${ntz.ntzBottom.toFixed(2)}–$${ntz.ntzTop.toFixed(2)}) — skipping`);
        continue;
      }
    }

    // ── ORB calculation ──────────────────────────────────────────────────────
    const orb = await fetchOrb(ticker);
    if (!orb) {
      console.log(`[Options Scalp] ${ticker}: ORB not available — skipping`);
      continue;
    }

    // ── Detect ORB breakout + retest ─────────────────────────────────────────
    const setup = detectOrbSetup(bars5m, orb, price, ticker);
    if (!setup) {
      console.log(`[Options Scalp] ${ticker}: no valid ORB retest setup (ORB $${orb.orbLow.toFixed(2)}–$${orb.orbHigh.toFixed(2)}, price $${price.toFixed(2)}, SMA→${smaDirection})`);
      continue;
    }

    // ── Direction agreement: SMA must agree with ORB setup ──────────────────
    if (setup.direction !== smaDirection) {
      console.log(`[Options Scalp] ${ticker}: ORB says ${setup.direction} but 200 SMA says ${smaDirection} — conflicting, skipping`);
      continue;
    }

    const right  = setup.direction;
    const signal = right === 'C' ? 'BUY' : 'SELL';

    // ── SPY VWAP regime gate ─────────────────────────────────────────────────
    // Only take calls in a BULLISH regime (SPY > VWAP), puts in BEARISH.
    // Prevents buying calls during downtrend VWAP-reclaim traps and vice-versa.
    const regime = await getSpyRegime();
    if ((right === 'C' && regime !== 'BULLISH') || (right === 'P' && regime !== 'BEARISH')) {
      console.log(`[Options Scalp] ${ticker}: ORB ${right === 'C' ? 'CALL' : 'PUT'} blocked by SPY regime (${regime}) — skipping`);
      continue;
    }

    console.log(`[Options Scalp] ${ticker}: ORB retest setup — ${right === 'C' ? 'CALL' : 'PUT'} | regime ${regime} ✓ | breakout vol ${setup.breakoutVol} vs retest vol ${setup.retestVol} | price $${price.toFixed(2)}`);

    // ── Find ATM strike ──────────────────────────────────────────────────────
    const atm = await findAtmStrike(ticker, right, price, expiry);
    if (!atm) {
      console.log(`[Options Scalp] ${ticker}: no ATM strike found`);
      continue;
    }

    if (atm.bid < 0.10) {
      console.log(`[Options Scalp] ${ticker}: bid too thin ($${atm.bid}) — skipping`);
      continue;
    }

    const premiumCost = atm.ask * 100 * MAX_CONTRACTS;
    if (premiumCost > MAX_PREMIUM_PER_TRADE) {
      console.log(`[Options Scalp] ${ticker}: premium $${premiumCost.toFixed(0)} > cap $${MAX_PREMIUM_PER_TRADE} — skipping`);
      continue;
    }

    const intradayMovePct = q.open ? ((price - q.open) / q.open) * 100 : 0;

    // Execute
    const ok = await executeScalp({
      ticker, right, signal: signal as 'BUY' | 'SELL',
      strike: atm.strike, expiry,
      limitPrice: atm.ask, contracts: MAX_CONTRACTS,
      price, intradayMovePct, delta: atm.delta,
      spreadPct: atm.spreadPct,
    });
    if (ok) placed++;
  }

  console.log(`[Options Scalp] Scan done — placed ${placed} trade(s)`);
}

// ── VWAP Retest Scalp ─────────────────────────────────────
//
// Kay Capitals "Advanced VWAP Strategy":
//   1. Price was below VWAP → 5-min candle closes ABOVE VWAP (reclaim)
//   2. Next candle pulls back toward VWAP (retest)
//   3. Enter ATM CALL at the bounce — stop below VWAP, target intraday high
//
//   Mirror for puts:
//   1. Price was above VWAP → candle closes BELOW VWAP (breakdown)
//   2. Retest from below → enter ATM PUT
//
// Runs every 15 min between 10 AM–3 PM ET (wired into the management cron).
// Scans a broad universe of liquid tickers (not just the 15-ticker watchlist).

const VWAP_RETEST_UNIVERSE = [
  // Index ETFs — most liquid options, tight spreads
  'QQQ', 'SPY', 'IWM', 'SMH',
  // Mega cap — huge options flow, reliable VWAP levels
  'AAPL', 'NVDA', 'TSLA', 'META', 'AMZN', 'GOOGL', 'MSFT', 'AVGO',
  // High-vol growth — frequent VWAP retests
  'AMD', 'PLTR', 'CRDO', 'HOOD', 'COIN', 'RKLB', 'APP', 'ALAB',
  // Momentum names often in play
  'MSTR', 'SOFI', 'SOXL', 'TQQQ',
  // Leveraged single-asset ETFs — daily chains, high vol
  'NVDL', 'TSLL',
];

// ETF-only subset for Mon–Thu: these have daily (Mon–Fri) options chains in IB.
// Individual stocks and even mega-caps only have weekly Friday expirations — they
// generate ib_error (code-200) on every 0DTE attempt Mon–Thu, flooding the DB
// with useless CANCELLED records. On Friday all tickers are valid (weekly = 0DTE).
// NVDL/TSLL included: leveraged single-asset ETFs with daily chains like SOXL/TQQQ.
const VWAP_ETF_ONLY_UNIVERSE = ['QQQ', 'SPY', 'IWM', 'SMH', 'SOXL', 'TQQQ', 'NVDL', 'TSLL'];

/**
 * VWAP retest scalp scanner — runs every 15 min 10 AM–3 PM ET.
 * Detects VWAP reclaim/breakdown + retest pattern and buys ATM call/put.
 */
export async function runVwapRetestScalpScan(): Promise<void> {
  // Only reliable after 10 AM ET; no new entries after 11:30 AM ET (90-minute rule)
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = nowET.getHours();
  const etMin  = nowET.getMinutes();
  if (etHour < VWAP_RELIABLE_HOUR_ET) return;
  if (etHour > LAST_ENTRY_HOUR_ET || (etHour === LAST_ENTRY_HOUR_ET && etMin >= LAST_ENTRY_MIN_ET)) {
    console.log('[VWAP Scalp] Past 11:00 AM ET — no new entries (90-min rule)');
    return;
  }

  if (!isConnected()) {
    console.log('[VWAP Scalp] IB not connected — skipping');
    return;
  }

  const sb = getSupabase();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Combined daily cap — VWAP retests count toward the same limit.
  // Only count filled/live trades — CANCELLED/REJECTED (e.g. IB code-200 failures)
  // must not consume a slot. Also exclude ib_reconciliation_cover records.
  const { data: todayTrades } = await sb
    .from('paper_trades')
    .select('id')
    .eq('mode', 'OPTIONS_SCALP')
    .neq('close_reason', 'ib_reconciliation_cover')
    .not('status', 'in', '(CANCELLED,REJECTED,EXPIRED)')
    .gte('opened_at', todayStart.toISOString());
  const usedToday = (todayTrades ?? []).length;
  if (usedToday >= MAX_SCALP_TRADES_PER_DAY) {
    console.log(`[VWAP Scalp] Daily cap reached (${usedToday}/${MAX_SCALP_TRADES_PER_DAY})`);
    return;
  }

  const expiry = getTodayExpiry();
  const slotsLeft = MAX_SCALP_TRADES_PER_DAY - usedToday;
  let placed = 0;

  // Mon–Thu: restrict to ETFs that have daily options chains in IB.
  // On Fridays, weekly expiry = 0DTE for all tickers, so the full universe runs.
  const isFriday = nowET.getDay() === 5;
  const universe = isFriday ? VWAP_RETEST_UNIVERSE : VWAP_ETF_ONLY_UNIVERSE;

  console.log(`[VWAP Scalp] Scanning ${universe.length} tickers (${isFriday ? 'full universe' : 'ETF-only — Mon–Thu'}) | expiry ${expiry} | slots ${slotsLeft}`);

  for (const ticker of universe) {
    if (placed >= slotsLeft) break;

    // Skip if already in an open scalp for this ticker today
    const { data: existing } = await sb
      .from('paper_trades')
      .select('id')
      .eq('mode', 'OPTIONS_SCALP')
      .eq('ticker', ticker)
      .in('status', ['SUBMITTED', 'FILLED', 'PARTIAL'])
      .gte('opened_at', todayStart.toISOString());
    if (existing?.length) continue;

    // Check both directions — whichever reclaim/breakdown is active
    let direction: 'BUY' | 'SELL' | null = null;
    let reclaimLog = '';

    const bullish = await detectVwapReclaim(ticker, 'BUY');
    if (bullish.reclaimed) {
      direction = 'BUY';
      reclaimLog = bullish.log;
    } else {
      const bearish = await detectVwapReclaim(ticker, 'SELL');
      if (bearish.reclaimed) {
        direction = 'SELL';
        reclaimLog = bearish.log;
      }
    }

    if (!direction) {
      console.log(`[VWAP Scalp] ${ticker}: no retest signal`);
      continue;
    }

    // ── SPY VWAP regime gate ─────────────────────────────────────────────────
    const right: 'C' | 'P' = direction === 'BUY' ? 'C' : 'P';
    const regime = await getSpyRegime();
    if ((right === 'C' && regime !== 'BULLISH') || (right === 'P' && regime !== 'BEARISH')) {
      console.log(`[VWAP Scalp] ${ticker}: ${right === 'C' ? 'CALL' : 'PUT'} blocked by SPY regime (${regime}) — skipping`);
      continue;
    }

    // Get current quote for strike selection
    const q = await fetchQuote(ticker);
    if (!q?.price || q.price <= 0) continue;

    const price = q.price;
    const vwapLevel = direction === 'BUY'
      ? (await detectVwapReclaim(ticker, 'BUY')).vwap
      : (await detectVwapReclaim(ticker, 'SELL')).vwap;

    console.log(`[VWAP Scalp] ${ticker}: ${reclaimLog} → ${right === 'C' ? 'CALL' : 'PUT'} | regime ${regime} ✓`);

    // Find ATM strike
    const atm = await findAtmStrike(ticker, right, price, expiry);
    if (!atm) {
      console.log(`[VWAP Scalp] ${ticker}: no ATM strike found`);
      continue;
    }

    if (atm.bid < 0.10) {
      console.log(`[VWAP Scalp] ${ticker}: bid too thin ($${atm.bid}) — skipping`);
      continue;
    }

    const limitPrice = atm.ask;
    const premiumCost = limitPrice * 100 * MAX_CONTRACTS;
    if (premiumCost > MAX_PREMIUM_PER_TRADE) {
      console.log(`[VWAP Scalp] ${ticker}: premium $${premiumCost.toFixed(0)} > cap $${MAX_PREMIUM_PER_TRADE} — skipping`);
      continue;
    }

    const ok = await executeScalp({
      ticker, right, signal: direction,
      strike: atm.strike, expiry,
      limitPrice, contracts: MAX_CONTRACTS,
      price, intradayMovePct: 0,
      delta: atm.delta, spreadPct: atm.spreadPct,
      entryType: 'vwap_retest',
      vwap: vwapLevel,
    });

    if (ok) {
      placed++;
      console.log(`[VWAP Scalp] ✅ ${ticker} ${right === 'C' ? 'CALL' : 'PUT'} placed — ${reclaimLog}`);
    }
  }

  if (placed > 0) {
    console.log(`[VWAP Scalp] Done — placed ${placed} trade(s)`);
  }
}

// ── Execute ──────────────────────────────────────────────

interface ScalpParams {
  ticker: string;
  right: 'C' | 'P';
  signal: 'BUY' | 'SELL';
  strike: number;
  expiry: string;
  limitPrice: number;
  contracts: number;
  price: number;
  intradayMovePct: number;
  delta: number;
  spreadPct: number;
  /** 'momentum' = classic >1.5% intraday move; 'vwap_retest' = VWAP bounce entry */
  entryType?: 'momentum' | 'vwap_retest';
  /** VWAP level at entry time (only set for vwap_retest entries) */
  vwap?: number;
}

async function executeScalp(p: ScalpParams): Promise<boolean> {
  const sb = getSupabase();
  const account = getDefaultAccount() ?? undefined;

  const { data: trade, error } = await sb
    .from('paper_trades')
    .insert({
      ticker:         p.ticker,
      mode:           'OPTIONS_SCALP',
      signal:         p.signal,
      entry_price:    p.price,
      quantity:       p.contracts,
      position_size:  Math.round(p.limitPrice * 100 * p.contracts),
      status:         'SUBMITTED',
      option_strike:  p.strike,
      option_expiry:  p.expiry,
      option_premium: 0,
      option_contracts: p.contracts,
      option_delta:   p.delta,
      notes: p.entryType === 'vwap_retest'
        ? `[SCALP] Buy ${p.right === 'C' ? 'call' : 'put'}: $${p.strike} exp ${p.expiry} — VWAP retest @ $${(p.vwap ?? 0).toFixed(2)}`
        : `[SCALP] Buy ${p.right === 'C' ? 'call' : 'put'}: $${p.strike} exp ${p.expiry} — intraday ${p.intradayMovePct > 0 ? '+' : ''}${p.intradayMovePct.toFixed(1)}%`,
      scanner_reason: p.entryType === 'vwap_retest'
        ? `VWAP retest scalp — δ ${Math.abs(p.delta).toFixed(2)}, bounce off VWAP $${(p.vwap ?? 0).toFixed(2)}, spread ${p.spreadPct.toFixed(1)}%`
        : `Options scalp — δ ${Math.abs(p.delta).toFixed(2)}, ${p.intradayMovePct > 0 ? '+' : ''}${p.intradayMovePct.toFixed(1)}% intraday, spread ${p.spreadPct.toFixed(1)}%`,
    })
    .select('id')
    .single();

  if (error || !trade) {
    console.error(`[Options Scalp] DB insert failed for ${p.ticker}:`, error?.message);
    return false;
  }

  // Place IB order
  let result;
  try {
    result = await placeOptionsOrder({
      symbol:     p.ticker,
      right:      p.right,
      strike:     p.strike,
      expiry:     p.expiry,
      contracts:  p.contracts,
      limitPrice: p.limitPrice,
      action:     'BUY',
      ...(account ? { account } : {}),
    });
  } catch (err) {
    console.error(`[Options Scalp] IB order failed for ${p.ticker}:`, err instanceof Error ? err.message : err);
    await sb.from('paper_trades').update({
      status: 'CANCELLED', close_reason: 'ib_error', closed_at: new Date().toISOString(),
    }).eq('id', trade.id);
    return false;
  }

  if (result.timedOut || !result.avgFillPrice || result.avgFillPrice <= 0) {
    // Cancel the live GTC order in IB — without this the order stays open and can
    // ghost-fill the next morning even though the DB already shows CANCELLED.
    if (result.orderId && isConnected()) {
      try {
        cancelOrder(result.orderId);
        console.log(`[Options Scalp] ${p.ticker} — cancelled IB order #${result.orderId} (no fill)`);
      } catch (cancelErr) {
        console.warn(`[Options Scalp] ${p.ticker} — cancel IB #${result.orderId} failed:`, cancelErr instanceof Error ? cancelErr.message : cancelErr);
      }
    }
    await sb.from('paper_trades').update({
      status: 'CANCELLED', close_reason: 'no_fill', closed_at: new Date().toISOString(),
    }).eq('id', trade.id);
    console.log(`[Options Scalp] ${p.ticker} — no fill (timed out)`);
    return false;
  }

  await sb.from('paper_trades').update({
    ib_order_id:    result.orderId,
    status:         'FILLED',
    fill_price:     result.avgFillPrice,
    option_premium: result.avgFillPrice,
    filled_at:      new Date().toISOString(),
  }).eq('id', trade.id);

  console.log(`[Options Scalp] ✅ ${p.ticker} ${p.right === 'C' ? 'CALL' : 'PUT'} $${p.strike} @ $${result.avgFillPrice.toFixed(2)} | IB #${result.orderId}`);

  createAutoTradeEvent({
    ticker:     p.ticker,
    event_type: 'success',
    action:     'executed',
    source:     'scanner',
    mode:       'OPTIONS_SCALP',
    message: p.entryType === 'vwap_retest'
      ? `📈 Scalp ${p.right === 'C' ? 'CALL' : 'PUT'} $${p.strike} exp ${p.expiry} @ $${result.avgFillPrice.toFixed(2)} — VWAP retest (${p.right === 'C' ? 'bounce' : 'breakdown'}) @ $${(p.vwap ?? 0).toFixed(2)}`
      : `📈 Scalp ${p.right === 'C' ? 'CALL' : 'PUT'} $${p.strike} exp ${p.expiry} @ $${result.avgFillPrice.toFixed(2)} — intraday ${p.intradayMovePct > 0 ? '+' : ''}${p.intradayMovePct.toFixed(1)}%`,
    metadata:   { strike: p.strike, expiry: p.expiry, premium: result.avgFillPrice, delta: p.delta, right: p.right },
  }).catch(() => {});

  return true;
}

// ── Runner Stop Trailing ──────────────────────────────────

/**
 * Trail the runner stop based on stock structure (higher lows for calls,
 * lower highs for puts) — Kay Capitals: "base your stop on the stock price,
 * not the option price. Every time a new higher low forms, bring your stop up."
 *
 * Uses the last N completed 5-min bars (excludes the current incomplete bar).
 * Returns the new stop price if a better level is found, or null if not.
 *
 * Minimum improvement required ($MIN_TRAIL_MOVE) prevents stop from creeping
 * on noise — the new level must be meaningfully better than the current stop.
 */
const MIN_TRAIL_MOVE = 0.15; // stock must move at least $0.15 to trail stop

function trailRunnerStop(
  bars: IntradayBar[],
  currentStop: number,
  right: 'C' | 'P',
): number | null {
  // Exclude last bar — it may still be forming (incomplete candle)
  const completed = bars.slice(0, -1);
  if (completed.length < 3) return null;

  // Scan backwards to find the most recent confirmed structure point
  for (let i = completed.length - 1; i >= 1; i--) {
    if (right === 'C') {
      // For calls: trail stop up to higher lows
      const thisLow = completed[i].low;
      const prevLow = completed[i - 1].low;
      if (thisLow > prevLow && thisLow > currentStop + MIN_TRAIL_MOVE) {
        return thisLow;
      }
    } else {
      // For puts: trail stop down to lower highs
      const thisHigh = completed[i].high;
      const prevHigh = completed[i - 1].high;
      if (thisHigh < prevHigh && thisHigh < currentStop - MIN_TRAIL_MOVE) {
        return thisHigh;
      }
    }
  }
  return null;
}

// ── Position Management ───────────────────────────────────

/**
 * Called every 15 min during market hours.
 * Implements Kay Capitals partial-exit framework:
 *   1. At +50% (PARTIAL_TARGET): sell 1 contract, move stop on runner to break-even
 *   2. At +100% (PROFIT_TARGET): close all remaining contracts
 *   3. Break-even stop: if already partially exited and premium drops to entry → close runner
 *   4. Stop loss at -50%: only applies before any partial exit
 */
export async function manageScalpPositions(): Promise<void> {
  const sb = getSupabase();

  // No opened_at filter — include stale scalps from prior days so they get
  // management until the 3:45 PM EOD close sweeps them.
  const { data: positions } = await sb
    .from('paper_trades')
    .select('id, ticker, signal, option_strike, option_expiry, option_premium, option_contracts, ib_order_id, metadata, status, filled_at')
    .eq('mode', 'OPTIONS_SCALP')
    .in('status', ['FILLED', 'PARTIAL']);

  if (!positions?.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const pos of (positions as Array<{
    id: string; ticker: string; signal: string; status: string;
    option_strike: number; option_expiry: string;
    option_premium: number; option_contracts: number | null;
    ib_order_id: number | null; metadata: Record<string, unknown> | null;
    filled_at: string | null;
  }>)) {
    // Skip options that have already passed their expiry date — the contract no longer
    // exists in IB so Greeks calls will always fail. closeAllScalpPositionsEod handles
    // these on expiry day; they should not reappear in management on subsequent days.
    const expiryDate = parseExpiryDate(pos.option_expiry ?? '');
    if (expiryDate && expiryDate < today) {
      console.log(`[Options Scalp] ${pos.ticker} — option_expiry ${pos.option_expiry} is in the past, closing as expired_worthless (missed by EOD close)`);
      const right2 = pos.signal === 'BUY' ? 'C' : 'P';
      const meta2 = ((pos.metadata ?? {}) as Record<string, unknown>);
      const isPartial2 = pos.status === 'PARTIAL';
      const remaining2 = isPartial2 ? ((meta2.contracts_remaining as number | undefined) ?? 1) : (pos.option_contracts ?? MAX_CONTRACTS);
      // Fetch stock price to determine if expired ITM (auto-exercised) or OTM (worthless)
      const q2 = await fetchQuote(pos.ticker);
      const stockPx2 = q2?.price ?? null;
      const isItm2 = stockPx2 != null && (right2 === 'C' ? stockPx2 > pos.option_strike : stockPx2 < pos.option_strike);
      await closeScalpPosition(pos.id, pos.ticker, right2, pos.option_strike, pos.option_expiry,
        0, pos.option_premium, isItm2 ? 'auto_exercised' : 'expired_worthless',
        { contractsToSell: remaining2, existingMeta: meta2 });
      continue;
    }

    const premiumPaid = pos.option_premium ?? 0;
    if (premiumPaid <= 0) continue;

    const right = pos.signal === 'BUY' ? 'C' : 'P';
    const meta = (pos.metadata ?? {}) as Record<string, unknown>;
    const isPartiallyExited = pos.status === 'PARTIAL';
    const contractsRemaining = isPartiallyExited
      ? ((meta.contracts_remaining as number | undefined) ?? 1)
      : (pos.option_contracts ?? MAX_CONTRACTS);
    // After first partial, runner stop moves to entry premium (break-even)
    const breakEvenPremium = (meta.break_even_premium as number | undefined) ?? premiumPaid;

    // Get current stock price for Greek lookup
    const q = await fetchQuote(pos.ticker);
    if (!q?.price) {
      console.log(`[Options Scalp] ${pos.ticker} — quote unavailable, skipping management cycle`);
      continue;
    }

    const greeks = await getOptionGreeksForContract(
      pos.ticker, pos.option_strike, pos.option_expiry, right, q.price,
    );
    if (!greeks) {
      // On expiry day, IB stops providing Greeks for near-worthless OTM contracts.
      // Close them now using stock price instead of waiting for the 3:45 PM EOD sweep.
      const expiryDate = parseExpiryDate(pos.option_expiry ?? '');
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      if (expiryDate && expiryDate <= todayMidnight) {
        const isItm = right === 'C' ? q.price > pos.option_strike : q.price < pos.option_strike;
        console.log(`[Options Scalp] ${pos.ticker} — Greeks null on expiry day (${pos.option_expiry}), stock $${q.price.toFixed(2)} vs strike $${pos.option_strike} → ${isItm ? 'ITM auto_exercised' : 'OTM expired_worthless'}`);
        await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry,
          0, pos.option_premium, isItm ? 'auto_exercised' : 'expired_worthless',
          { contractsToSell: contractsRemaining, existingMeta: meta });
        continue;
      }
      console.log(`[Options Scalp] ${pos.ticker} — Greeks unavailable (IB disconnected?), skipping cycle`);
      continue;
    }

    const currentPremium = greeks.mid;

    // Guard: if IB returned a quote with no real bid/ask (timeout path can give mid ≈ 0.01),
    // skip this cycle rather than triggering a false stop-loss.
    if (currentPremium <= 0.05) {
      console.log(`[Options Scalp] ${pos.ticker} — mid $${currentPremium.toFixed(2)} suspiciously low, skipping cycle`);
      continue;
    }

    // Live P&L = already-realized partial P&L + unrealized on remaining contracts
    const partialRealized = (meta.partial_realized_pnl as number | undefined) ?? 0;
    const livePnl = partialRealized + (currentPremium - premiumPaid) * 100 * contractsRemaining;
    await sb.from('paper_trades').update({ pnl: livePnl }).eq('id', pos.id);

    const profitPct = ((currentPremium - premiumPaid) / premiumPaid) * 100;

    // ── Runner trailing stop (stock-price based, PARTIAL positions only) ──
    // Kay Capitals: "trail your stop based on higher highs and higher lows,
    // not the option premium."
    if (isPartiallyExited) {
      const runnerStop = (meta.runner_stop_price as number | undefined);

      if (runnerStop == null) {
        // First cycle after partial: initialize runner stop to current stock price
        // (with a tiny buffer so it doesn't exit immediately on noise)
        const initialStop = right === 'C'
          ? q.price * 0.998   // 0.2% below current for calls
          : q.price * 1.002;  // 0.2% above current for puts
        await getSupabase().from('paper_trades').update({
          metadata: { ...meta, runner_stop_price: initialStop },
        }).eq('id', pos.id);
        console.log(`[Options Scalp] ${pos.ticker} — runner stop initialized @ $${initialStop.toFixed(2)} (stock $${q.price.toFixed(2)})`);

      } else {
        // Kay Capitals: 2-min chart for first 30 min (9:30–10:00), 5-min chart 10:00–11:00.
        // Use whichever interval matches the session window the trade was entered in.
        const entryHour = pos.filled_at ? new Date(pos.filled_at as string).getUTCHours() - 4 : 10;
        const barInterval: '2m' | '5m' = entryHour < 10 ? '2m' : '5m';

        const intradayBars = await fetchIntradayBars(pos.ticker, barInterval, '1d');
        if (intradayBars && intradayBars.length >= 4) {
          console.log(`[Options Scalp] ${pos.ticker} — checking runner stop on ${barInterval} bars (${intradayBars.length} candles)`);
          const newStop = trailRunnerStop(intradayBars, runnerStop, right);
          if (newStop !== null) {
            await getSupabase().from('paper_trades').update({
              metadata: { ...meta, runner_stop_price: newStop },
            }).eq('id', pos.id);
            console.log(`[Options Scalp] ${pos.ticker} — runner stop trailed: $${runnerStop.toFixed(2)} → $${newStop.toFixed(2)}`);
            meta.runner_stop_price = newStop; // use updated value for exit check below
          }
        }

        // Check if stock price has crossed the runner stop
        const activeStop = (meta.runner_stop_price as number | undefined) ?? runnerStop;
        const stopHit = right === 'C'
          ? q.price <= activeStop
          : q.price >= activeStop;

        if (stopHit) {
          console.log(`[Options Scalp] ${pos.ticker} — runner stock stop hit (stock $${q.price.toFixed(2)} ${right === 'C' ? '<=' : '>='} stop $${activeStop.toFixed(2)})`);
          await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry,
            currentPremium, premiumPaid, 'runner_stop',
            { contractsToSell: contractsRemaining, existingMeta: meta });
          continue;
        }

        // Fallback: break-even option premium stop (in case stock stop isn't yet set or is stale)
        if (currentPremium <= breakEvenPremium) {
          console.log(`[Options Scalp] ${pos.ticker} — runner break-even stop @ $${currentPremium.toFixed(2)} (entry $${breakEvenPremium.toFixed(2)})`);
          await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry,
            currentPremium, premiumPaid, 'break_even_stop',
            { contractsToSell: contractsRemaining, existingMeta: meta });
          continue;
        }
      }
    }

    if (!isPartiallyExited && currentPremium >= premiumPaid * PARTIAL_TARGET_MULT) {
      // First target (+50%): sell 1 contract, set break-even stop on runner
      console.log(`[Options Scalp] ${pos.ticker} — partial target hit (+${profitPct.toFixed(0)}%) @ $${currentPremium.toFixed(2)} — selling 1, runner to break-even`);
      await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry,
        currentPremium, premiumPaid, 'partial_profit',
        { contractsToSell: 1, partial: true, existingMeta: meta });

    } else if (currentPremium >= premiumPaid * PROFIT_TARGET_MULT) {
      // Full profit target (+100%): close all remaining
      console.log(`[Options Scalp] ${pos.ticker} — profit target hit (+${profitPct.toFixed(0)}%) @ $${currentPremium.toFixed(2)}`);
      await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry,
        currentPremium, premiumPaid, 'profit_target',
        { contractsToSell: contractsRemaining, existingMeta: meta });

    } else if (!isPartiallyExited && currentPremium <= premiumPaid * STOP_LOSS_MULT) {
      // Stop loss (-50%): only before any partial exit
      console.log(`[Options Scalp] ${pos.ticker} — stop loss hit (${profitPct.toFixed(0)}%) @ $${currentPremium.toFixed(2)}`);
      await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry,
        currentPremium, premiumPaid, 'stop_loss',
        { contractsToSell: contractsRemaining, existingMeta: meta });
    }
  }
}

/**
 * EOD close — called at 3:45 PM ET.
 * Force-closes ALL open scalp positions regardless of when they were opened.
 * (The previous filter .gte('opened_at', todayStart) caused scalps from prior
 * days to get permanently stuck as FILLED with no close record.)
 */
export async function closeAllScalpPositionsEod(): Promise<void> {
  const sb = getSupabase();

  const { data: positions } = await sb
    .from('paper_trades')
    .select('id, ticker, signal, option_strike, option_expiry, option_premium')
    .eq('mode', 'OPTIONS_SCALP')
    .in('status', ['FILLED', 'PARTIAL']);

  if (!positions?.length) return;

  console.log(`[Options Scalp] EOD close — ${positions.length} open scalp(s)`);

  for (const pos of (positions as Array<{
    id: string; ticker: string; signal: string; status: string;
    option_strike: number; option_expiry: string; option_premium: number;
    option_contracts: number | null; metadata: Record<string, unknown> | null;
  }>)) {
    const right = pos.signal === 'BUY' ? 'C' : 'P';
    const meta = (pos.metadata ?? {}) as Record<string, unknown>;
    const isPartiallyExited = pos.status === 'PARTIAL';
    const contractsRemaining = isPartiallyExited
      ? ((meta.contracts_remaining as number | undefined) ?? 1)
      : (pos.option_contracts ?? MAX_CONTRACTS);

    // Fetch current stock price via Yahoo Finance.
    // Retry up to 3 times with a 3-second gap for transient network failures.
    let stockPrice: number | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const q = await fetchQuote(pos.ticker);
      if (q?.price) { stockPrice = q.price; break; }
      if (attempt < 3) {
        console.log(`[Options Scalp] ${pos.ticker} — Yahoo quote unavailable (attempt ${attempt}/3), retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3_000));
      }
    }

    if (!stockPrice) {
      console.log(`[Options Scalp] ${pos.ticker} — price unavailable after 3 retries, leaving open for management cycle`);
      continue;
    }

    // CRITICAL: getOptionGreeksForContract returns null when IB is disconnected.
    // null !== $0 (worthless) — if Greeks are unavailable, leave the position open
    // rather than incorrectly marking it CLOSED at $0. The next cycle will retry.
    //
    // Exception: if the option is ON its expiry date, IB drops the contract from
    // its chain after exercise/expiry — Greeks will always be null. In this case
    // we use the live stock price to determine ITM vs OTM and close accordingly.
    const greeks = await getOptionGreeksForContract(pos.ticker, pos.option_strike, pos.option_expiry, right, stockPrice);
    if (!greeks) {
      const expiryDate = parseExpiryDate(pos.option_expiry ?? '');
      const todayEod = new Date();
      todayEod.setHours(0, 0, 0, 0);

      if (expiryDate && expiryDate <= todayEod) {
        // Option has reached or passed its expiry — contract no longer exists in IB.
        // Use stock price to determine whether it expired ITM (auto-exercised) or OTM (worthless).
        const isItm = right === 'C'
          ? stockPrice > pos.option_strike
          : stockPrice < pos.option_strike;

        if (isItm) {
          // ITM at expiry → OCC auto-exercised. A short stock position (for puts) or long
          // stock position (for calls) was created in IB. reconcileIBShorts/Longs will
          // detect and handle the resulting stock position. Mark the option record closed.
          console.log(`[Options Scalp] ${pos.ticker} — expired ITM on ${pos.option_expiry} (${right === 'C' ? 'CALL' : 'PUT'} $${pos.option_strike}, stock $${stockPrice.toFixed(2)}) — auto-exercised, P&L tracked when stock cover happens`);
          await closeScalpPosition(
            pos.id, pos.ticker, right,
            pos.option_strike, pos.option_expiry,
            0, pos.option_premium, 'auto_exercised',
            { contractsToSell: contractsRemaining, existingMeta: meta },
          );
        } else {
          // OTM at expiry → expired worthless. Full premium is the loss.
          console.log(`[Options Scalp] ${pos.ticker} — expired OTM worthless on ${pos.option_expiry} (${right === 'C' ? 'CALL' : 'PUT'} $${pos.option_strike}, stock $${stockPrice.toFixed(2)})`);
          await closeScalpPosition(
            pos.id, pos.ticker, right,
            pos.option_strike, pos.option_expiry,
            0, pos.option_premium, 'expired_worthless',
            { contractsToSell: contractsRemaining, existingMeta: meta },
          );
        }
      } else {
        console.warn(`[Options Scalp] ${pos.ticker} — IB Greeks unavailable (disconnected?), leaving open — DO NOT mark as $0`);
      }
      continue;
    }

    const currentPremium = greeks.mid;

    await closeScalpPosition(
      pos.id, pos.ticker, right,
      pos.option_strike, pos.option_expiry,
      currentPremium, pos.option_premium, 'eod_close',
      { contractsToSell: contractsRemaining, existingMeta: meta },
    );
  }
}

// ── Close Helper ─────────────────────────────────────────

interface CloseOpts {
  /** How many contracts to sell (default 1). */
  contractsToSell?: number;
  /** If true, this is a partial close — update status to PARTIAL, not CLOSED. */
  partial?: boolean;
  /** Existing metadata to merge into (preserves partial_realized_pnl etc). */
  existingMeta?: Record<string, unknown>;
}

async function closeScalpPosition(
  tradeId: string,
  ticker: string,
  right: 'C' | 'P',
  strike: number,
  expiry: string,
  closePremium: number,
  premiumPaid: number,
  reason: string,
  opts: CloseOpts = {},
): Promise<void> {
  const sb = getSupabase();
  const account = getDefaultAccount() ?? undefined;
  const contractsToSell = opts.contractsToSell ?? 1;
  const isPartial = opts.partial ?? false;
  const existingMeta = opts.existingMeta ?? {};

  // If IB Greeks returned null (disconnected), closePremium will be 0 via `?.mid ?? 0`.
  // Distinguish: $0 on expiry day = genuinely worthless. $0 any other time = IB unavailable.
  // Callers that pass closePremium from getOptionGreeksForContract must guard: if greeks === null,
  // they should skip rather than calling here with 0.
  if (closePremium <= 0) {
    const expiryDate = new Date(expiry);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expiryDate.setHours(0, 0, 0, 0);
    const daysToExpiry = Math.round((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysToExpiry > 0) {
      console.log(`[Options Scalp] ${ticker} premium=$0 but ${daysToExpiry}d to expiry (${expiry}) — leaving open, model may be wrong`);
      return;
    }
    // daysToExpiry = 0: expiring today, $0 is genuine.
  }

  // Place sell-to-close order in IB when premium > $0.
  // If the order fails we MUST NOT update DB — IB still holds the position.
  if (isConnected() && closePremium > 0) {
    try {
      await placeOptionsOrder({
        symbol:     ticker,
        right,
        strike,
        expiry,
        contracts:  contractsToSell,
        limitPrice: closePremium,
        action:     'SELL',
        ...(account ? { account } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Options Scalp] Close order FAILED for ${ticker} — leaving open, will retry: ${msg}`);
      createAutoTradeEvent({
        ticker, event_type: 'error', action: 'failed', source: 'scanner', mode: 'OPTIONS_SCALP',
        message: `Close order failed [${reason}] — position left OPEN in IB: ${msg}`,
        metadata: { reason, closePremium, premiumPaid, contractsToSell },
      }).catch(() => {});
      return;
    }
  } else if (!isConnected() && closePremium > 0) {
    console.warn(`[Options Scalp] ${ticker} — IB disconnected, cannot close, leaving open`);
    return;
  }
  // closePremium === 0: option worthless on expiry day, no IB sell needed.

  const contractPnl = (closePremium - premiumPaid) * 100 * contractsToSell;

  if (isPartial) {
    // Partial close: update metadata, mark PARTIAL, accumulate realized P&L
    const prevRealized = (existingMeta.partial_realized_pnl as number | undefined) ?? 0;
    const prevRemaining = (existingMeta.contracts_remaining as number | undefined) ?? MAX_CONTRACTS;
    const newRealized = prevRealized + contractPnl;
    const newRemaining = prevRemaining - contractsToSell;

    await sb.from('paper_trades').update({
      status: 'PARTIAL',
      pnl:    newRealized, // realized portion only; unrealized updated each cycle
      metadata: {
        ...existingMeta,
        partial_realized_pnl:  newRealized,
        contracts_remaining:   newRemaining,
        break_even_premium:    premiumPaid, // runner stop = entry price
        partial_close_reason:  reason,
        partial_closed_at:     new Date().toISOString(),
      },
    }).eq('id', tradeId);

    const pnlStr = contractPnl >= 0 ? `+$${contractPnl.toFixed(0)}` : `-$${Math.abs(contractPnl).toFixed(0)}`;
    console.log(`[Options Scalp] ${ticker} partial close [${reason}] @ $${closePremium.toFixed(2)} | realized ${pnlStr} | ${newRemaining} contract(s) running to break-even`);

    createAutoTradeEvent({
      ticker,
      event_type: 'success',
      action:     'closed',
      source:     'scanner',
      mode:       'OPTIONS_SCALP',
      message:    `📊 Scalp ${right === 'C' ? 'CALL' : 'PUT'} $${strike} partial [${reason}] @ $${closePremium.toFixed(2)} | ${pnlStr} locked | runner to break-even`,
      metadata:   { reason, contractPnl, closePremium, premiumPaid, contractsToSell, newRemaining },
    }).catch(() => {});

  } else {
    // Full close (or final contract of a partial)
    const prevRealized = (existingMeta.partial_realized_pnl as number | undefined) ?? 0;

    // auto_exercised: option was ITM at expiry and exercised by OCC, creating a stock
    // position in IB. The stock P&L is unknown until reconcileIBShorts/Longs covers it.
    // Store pnl=null here; reconcileIBShorts will update it with the full round-trip P&L.
    const totalPnl = reason === 'auto_exercised' ? null : prevRealized + contractPnl;

    await sb.from('paper_trades').update({
      status:       'CLOSED',
      close_reason: reason,
      close_price:  closePremium,
      closed_at:    new Date().toISOString(),
      pnl:          totalPnl,
    }).eq('id', tradeId);

    // totalPnl is null for auto_exercised (P&L tracked by reconcileIBShorts on cover)
    const pnlStr = totalPnl == null
      ? 'pending exercise cover'
      : totalPnl >= 0 ? `+$${totalPnl.toFixed(0)}` : `-$${Math.abs(totalPnl).toFixed(0)}`;
    console.log(`[Options Scalp] ${ticker} closed [${reason}] @ $${closePremium.toFixed(2)} | total P&L ${pnlStr}`);

    createAutoTradeEvent({
      ticker,
      event_type: totalPnl == null ? 'info' : totalPnl >= 0 ? 'success' : 'warning',
      action:     'closed',
      source:     'scanner',
      mode:       'OPTIONS_SCALP',
      message:    totalPnl == null
        ? `📋 Scalp ${right === 'C' ? 'CALL' : 'PUT'} $${strike} auto-exercised ITM [${reason}] — P&L pending stock cover by reconcileIBShorts`
        : `${totalPnl >= 0 ? '✅' : '🛑'} Scalp ${right === 'C' ? 'CALL' : 'PUT'} $${strike} closed [${reason}] @ $${closePremium.toFixed(2)} | P&L ${pnlStr}`,
      metadata:   { reason, totalPnl, closePremium, premiumPaid, contractsToSell },
    }).catch(() => {});
  }
}
