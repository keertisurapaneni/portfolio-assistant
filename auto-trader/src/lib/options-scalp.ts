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
import { isConnected, placeOptionsOrder, getDefaultAccount } from '../ib-connection.js';
import { findAtmStrike, getOptionGreeksForContract } from './options-chain.js';
import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';
import { detectVwapReclaim, VWAP_RELIABLE_HOUR_ET } from './vwap.js';

// ── Constants ────────────────────────────────────────────
const MAX_SCALP_TRADES_PER_DAY = 2;
const MAX_PREMIUM_PER_TRADE = 500;       // max $500 in premium (= limitPrice × 100)
const MAX_CONTRACTS = 1;
const INTRADAY_MOVE_MIN_PCT = 1.5;       // stock must have moved >1.5% from open
const PROFIT_TARGET_MULT = 2.0;          // close when premium doubles
const STOP_LOSS_MULT = 0.50;             // close when premium halves
const MAX_SPREAD_MARKET_ORDER_PCT = 3;   // use market order only if spread < 3% of mid

/** Return nearest weekly Friday expiry that is at least 1 day away, as YYYYMMDD. */
function getNearestWeeklyExpiry(): string {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 5=Fri
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7; // if already Fri, go to next Fri
  const candidate = new Date(now);
  candidate.setDate(now.getDate() + daysUntilFriday);

  // If less than 1 calendar day to this Friday, jump to next Friday
  const msToFriday = candidate.getTime() - now.getTime();
  if (msToFriday < 86_400_000) candidate.setDate(candidate.getDate() + 7);

  const y  = candidate.getFullYear();
  const mo = String(candidate.getMonth() + 1).padStart(2, '0');
  const d  = String(candidate.getDate()).padStart(2, '0');
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

  // Guard: IB must be connected to get live chain data
  if (!isConnected()) {
    console.log('[Options Scalp] IB not connected — skipping scan');
    return;
  }

  // Daily cap check
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: todayTrades } = await sb
    .from('paper_trades')
    .select('id')
    .eq('mode', 'OPTIONS_SCALP')
    .gte('opened_at', todayStart.toISOString());
  const usedToday = (todayTrades ?? []).length;
  if (usedToday >= MAX_SCALP_TRADES_PER_DAY) {
    console.log(`[Options Scalp] Daily cap reached (${usedToday}/${MAX_SCALP_TRADES_PER_DAY})`);
    return;
  }

  // Load HIGH_VOL options watchlist tickers
  const { data: watchlist } = await sb
    .from('options_watchlist')
    .select('ticker')
    .eq('active', true)
    .eq('tier', 'HIGH_VOL');
  if (!watchlist?.length) return;

  const expiry = getNearestWeeklyExpiry();
  const slotsLeft = MAX_SCALP_TRADES_PER_DAY - usedToday;

  console.log(`[Options Scalp] Scanning ${watchlist.length} HIGH_VOL tickers | expiry ${expiry} | slots ${slotsLeft}`);

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

    // Get quote — need open price to measure intraday move
    const q = await finnhubFetch<{ c?: number; o?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`,
    );
    if (!q?.c || !q?.o || q.o === 0) continue;

    const price = q.c;
    const openPrice = q.o;
    const intradayMovePct = ((price - openPrice) / openPrice) * 100;

    if (Math.abs(intradayMovePct) < INTRADAY_MOVE_MIN_PCT) {
      console.log(`[Options Scalp] ${ticker}: move ${intradayMovePct.toFixed(1)}% — below threshold, skipping`);
      continue;
    }

    const signal = intradayMovePct > 0 ? 'BUY' : 'SELL';
    const right   = signal === 'BUY' ? 'C' : 'P';

    console.log(`[Options Scalp] ${ticker}: ${intradayMovePct.toFixed(1)}% intraday → ${signal === 'BUY' ? 'CALL' : 'PUT'}`);

    // Find ATM strike (kaycapitals rule: ATM, round strike, real bid)
    const atm = await findAtmStrike(ticker, right, price, expiry);
    if (!atm) {
      console.log(`[Options Scalp] ${ticker}: no ATM strike found`);
      continue;
    }

    // atm.mid === 0 means the chain came from the market-order fallback (no live
    // options data subscription available). Skip bid/premium checks — no price data.
    // On a live account with an options subscription, mid > 0 and LMT runs instead.
    const useMarket = atm.mid === 0;

    if (!useMarket) {
      if (atm.bid < 0.10) {
        console.log(`[Options Scalp] ${ticker}: bid too thin ($${atm.bid}) — skipping`);
        continue;
      }
      const premiumCost = atm.ask * 100 * MAX_CONTRACTS;
      if (premiumCost > MAX_PREMIUM_PER_TRADE) {
        console.log(`[Options Scalp] ${ticker}: premium $${premiumCost.toFixed(0)} > cap $${MAX_PREMIUM_PER_TRADE} — skipping`);
        continue;
      }
    }

    const limitPrice = useMarket ? 0 : atm.ask;

    // Execute
    const ok = await executeScalp({
      ticker, right, signal: signal as 'BUY' | 'SELL',
      strike: atm.strike, expiry,
      limitPrice, contracts: MAX_CONTRACTS,
      price, intradayMovePct, delta: atm.delta,
      spreadPct: atm.spreadPct,
      useMarket,
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
];

/**
 * VWAP retest scalp scanner — runs every 15 min 10 AM–3 PM ET.
 * Detects VWAP reclaim/breakdown + retest pattern and buys ATM call/put.
 */
export async function runVwapRetestScalpScan(): Promise<void> {
  // Only reliable after 10 AM ET
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = nowET.getHours();
  if (etHour < VWAP_RELIABLE_HOUR_ET || etHour >= 15) return;

  if (!isConnected()) {
    console.log('[VWAP Scalp] IB not connected — skipping');
    return;
  }

  const sb = getSupabase();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Combined daily cap — VWAP retests count toward the same 2-trade limit
  const { data: todayTrades } = await sb
    .from('paper_trades')
    .select('id')
    .eq('mode', 'OPTIONS_SCALP')
    .gte('opened_at', todayStart.toISOString());
  const usedToday = (todayTrades ?? []).length;
  if (usedToday >= MAX_SCALP_TRADES_PER_DAY) {
    console.log(`[VWAP Scalp] Daily cap reached (${usedToday}/${MAX_SCALP_TRADES_PER_DAY})`);
    return;
  }

  const expiry = getNearestWeeklyExpiry();
  const slotsLeft = MAX_SCALP_TRADES_PER_DAY - usedToday;
  let placed = 0;

  console.log(`[VWAP Scalp] Scanning ${VWAP_RETEST_UNIVERSE.length} tickers | slots ${slotsLeft}`);

  for (const ticker of VWAP_RETEST_UNIVERSE) {
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

    // Get current quote for strike selection
    const q = await finnhubFetch<{ c?: number; o?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`,
    );
    if (!q?.c || q.c <= 0) continue;

    const price = q.c;
    const vwapLevel = direction === 'BUY'
      ? (await detectVwapReclaim(ticker, 'BUY')).vwap
      : (await detectVwapReclaim(ticker, 'SELL')).vwap;

    const right: 'C' | 'P' = direction === 'BUY' ? 'C' : 'P';
    console.log(`[VWAP Scalp] ${ticker}: ${reclaimLog} → ${right === 'C' ? 'CALL' : 'PUT'}`);

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
  /** Use MKT order — set when no live options chain was available (paper account). */
  useMarket?: boolean;
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
      useMarket:  p.useMarket,
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

// ── Position Management ───────────────────────────────────

/**
 * Called every 15 min during market hours.
 * Checks profit target, stop loss, and writes live P&L.
 */
export async function manageScalpPositions(): Promise<void> {
  const sb = getSupabase();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: positions } = await sb
    .from('paper_trades')
    .select('id, ticker, signal, option_strike, option_expiry, option_premium, ib_order_id')
    .eq('mode', 'OPTIONS_SCALP')
    .in('status', ['FILLED', 'PARTIAL'])
    .gte('opened_at', todayStart.toISOString());

  if (!positions?.length) return;

  for (const pos of (positions as Array<{
    id: string; ticker: string; signal: string;
    option_strike: number; option_expiry: string;
    option_premium: number; ib_order_id: number | null;
  }>)) {
    const premiumPaid = pos.option_premium ?? 0;
    if (premiumPaid <= 0) continue;

    const right = pos.signal === 'BUY' ? 'C' : 'P';

    // Get current stock price for Greek lookup
    const q = await finnhubFetch<{ c?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB_KEY}`,
    );
    if (!q?.c) continue;

    const greeks = await getOptionGreeksForContract(
      pos.ticker, pos.option_strike, pos.option_expiry, right, q.c,
    );
    if (!greeks) continue;

    const currentPremium = greeks.mid;

    // Guard: if IB returned a quote with no real bid/ask (timeout path can give mid ≈ 0.01),
    // skip this cycle rather than triggering a false stop-loss.
    if (currentPremium <= 0.05) {
      console.log(`[Options Scalp] ${pos.ticker} — mid $${currentPremium.toFixed(2)} suspiciously low, skipping cycle`);
      continue;
    }

    const pnl = (currentPremium - premiumPaid) * 100;

    // Write live P&L
    await sb.from('paper_trades').update({ pnl }).eq('id', pos.id);

    const profitPct = ((currentPremium - premiumPaid) / premiumPaid) * 100;

    if (currentPremium >= premiumPaid * PROFIT_TARGET_MULT) {
      console.log(`[Options Scalp] ${pos.ticker} — profit target hit (+${profitPct.toFixed(0)}%) @ $${currentPremium.toFixed(2)}`);
      await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry, currentPremium, premiumPaid, 'profit_target');
    } else if (currentPremium <= premiumPaid * STOP_LOSS_MULT) {
      console.log(`[Options Scalp] ${pos.ticker} — stop loss hit (${profitPct.toFixed(0)}%) @ $${currentPremium.toFixed(2)}`);
      await closeScalpPosition(pos.id, pos.ticker, right, pos.option_strike, pos.option_expiry, currentPremium, premiumPaid, 'stop_loss');
    }
  }
}

/**
 * EOD close — called at 3:45 PM ET.
 * Force-closes all open scalp positions.
 */
export async function closeAllScalpPositionsEod(): Promise<void> {
  const sb = getSupabase();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: positions } = await sb
    .from('paper_trades')
    .select('id, ticker, signal, option_strike, option_expiry, option_premium')
    .eq('mode', 'OPTIONS_SCALP')
    .in('status', ['FILLED', 'PARTIAL'])
    .gte('opened_at', todayStart.toISOString());

  if (!positions?.length) return;

  console.log(`[Options Scalp] EOD close — ${positions.length} open scalp(s)`);

  for (const pos of (positions as Array<{
    id: string; ticker: string; signal: string;
    option_strike: number; option_expiry: string; option_premium: number;
  }>)) {
    const right = pos.signal === 'BUY' ? 'C' : 'P';
    const q = await finnhubFetch<{ c?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB_KEY}`,
    );
    const currentPremium = q?.c
      ? (await getOptionGreeksForContract(pos.ticker, pos.option_strike, pos.option_expiry, right, q.c))?.mid ?? 0
      : 0;

    await closeScalpPosition(
      pos.id, pos.ticker, right,
      pos.option_strike, pos.option_expiry,
      currentPremium, pos.option_premium, 'eod_close',
    );
  }
}

// ── Close Helper ─────────────────────────────────────────

async function closeScalpPosition(
  tradeId: string,
  ticker: string,
  right: 'C' | 'P',
  strike: number,
  expiry: string,
  closePremium: number,
  premiumPaid: number,
  reason: string,
): Promise<void> {
  const sb = getSupabase();
  const account = getDefaultAccount() ?? undefined;

  const pnl = (closePremium - premiumPaid) * 100;

  // Place sell-to-close order in IB
  if (isConnected() && closePremium > 0) {
    try {
      await placeOptionsOrder({
        symbol:    ticker,
        right,
        strike,
        expiry,
        contracts: 1,
        limitPrice: closePremium,
        action:    'SELL',
        ...(account ? { account } : {}),
      });
    } catch (err) {
      console.error(`[Options Scalp] Close order failed for ${ticker}:`, err instanceof Error ? err.message : err);
    }
  }

  await sb.from('paper_trades').update({
    status:      'CLOSED',
    close_reason: reason,
    close_price:  closePremium,
    closed_at:    new Date().toISOString(),
    pnl,
  }).eq('id', tradeId);

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
  console.log(`[Options Scalp] ${ticker} closed [${reason}] @ $${closePremium.toFixed(2)} | P&L ${pnlStr}`);

  createAutoTradeEvent({
    ticker,
    event_type: pnl >= 0 ? 'success' : 'warning',
    action:     'closed',
    source:     'scanner',
    mode:       'OPTIONS_SCALP',
    message:    `${pnl >= 0 ? '✅' : '🛑'} Scalp ${right === 'C' ? 'CALL' : 'PUT'} $${strike} closed [${reason}] @ $${closePremium.toFixed(2)} | P&L ${pnlStr}`,
    metadata:   { reason, pnl, closePremium, premiumPaid },
  }).catch(() => {});
}
