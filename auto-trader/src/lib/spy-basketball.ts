/**
 * SPY Basketball Strategy — Kay Capitals
 *
 * SPX moves in 50-point increments (7050, 7000, 6950, …).
 * Each of these levels ±2 SPX points (≈ ±$0.20 SPY) is a high-probability
 * rejection/support zone. When price freshly enters one of these zones from
 * outside, institutional order flow creates a powerful bounce — like a
 * basketball hitting the rim.
 *
 * Entry conditions (all must pass):
 *   1. Market near its 52-week high (SPY ≥ 95% of h52) — basketball zones
 *      only produce strong rejections when the market is extended near ATH.
 *   2. Time window: 10:00 AM – 3:00 PM ET.
 *   3. A 5-min bar freshly enters a $5 SPY zone (prior bar was outside,
 *      current bar is inside the ±$0.20 band around the round level).
 *   4. Approaching from BELOW → resistance rejection → buy 0DTE ATM PUT.
 *      Approaching from ABOVE → support bounce → buy 0DTE ATM CALL.
 *
 * Exit rules (managed by existing manageScalpPositions loop):
 *   - 100% profit target (premium doubles)
 *   - 50% stop loss (premium halves)
 *   - 3:30 PM ET forced close (0DTE — 15 min earlier than regular scalp)
 *
 * Limits:
 *   - Max 1 basketball trade per day (0DTE is higher risk than weekly scalp)
 *   - Max $500 premium per trade, 1 contract
 *   - Uses OPTIONS_SCALP mode so management/EOD loops already handle it
 *   - option_expiry = today → natural distinguisher from weekly scalp trades
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { isConnected, placeOptionsOrder, cancelOrder, getDefaultAccount, resolveOptionConId } from '../ib-connection.js';
import { findAtmStrike, getOptionGreeksForContract, type AtmPricingSource } from './options-chain.js';
import { finnhubFetch, FINNHUB_KEY, FINNHUB_BASE } from './finnhub.js';
import { fetchVwap } from './vwap.js';

// ── Constants ───────────────────────────────────────────────────────────────

const TICKER = 'SPY';

/** Every $5 SPY level corresponds to a ~50 SPX-point psychological level */
const SPY_ZONE_INTERVAL = 5;

/**
 * ±$0.20 band around each $5 level.
 * Kay Capitals specifies ±2 SPX points → ±$0.20 SPY (SPY ≈ SPX/10).
 */
const ZONE_HALF_WIDTH = 0.20;

/**
 * ATH proximity gate: basketball strategy only works near all-time highs.
 * Below 95% of 52-week high = too far from ATH = zones are less reliable.
 */
const ATH_PROXIMITY_THRESHOLD = 0.95;

const MAX_TRADES_PER_DAY = 1;   // 0DTE — max 1 basketball trade per day
const CONTRACTS = 1;
const MAX_PREMIUM = 500;        // $500 cap (1 contract × $5.00 premium)

// Reuse the same profit/loss multipliers as regular scalp
const PROFIT_TARGET_MULT = 2.0;
const STOP_LOSS_MULT = 0.50;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Nearest $5 SPY level to a given price */
function nearestFiveLevel(price: number): number {
  return Math.round(price / SPY_ZONE_INTERVAL) * SPY_ZONE_INTERVAL;
}

/** True if the price is inside the ±$0.20 band around a $5 level */
function isInBasketballZone(price: number): { inZone: boolean; level: number } {
  const level = nearestFiveLevel(price);
  return { inZone: Math.abs(price - level) <= ZONE_HALF_WIDTH, level };
}

/** Today's expiry in YYYYMMDD format (ET timezone) */
function getTodayExpiry(): string {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const y  = et.getFullYear();
  const mo = String(et.getMonth() + 1).padStart(2, '0');
  const d  = String(et.getDate()).padStart(2, '0');
  return `${y}${mo}${d}`;
}

/**
 * Fetch recent SPY 5-min closes from Yahoo Finance.
 * Returns the last `n` valid closes, or null on failure.
 */
async function getRecentSpyBars(n = 6): Promise<number[] | null> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=5m&includePrePost=false';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const closes: (number | null)[] = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const valid = closes.filter((c): c is number => c != null && c > 0);
    return valid.length >= n ? valid.slice(-n) : valid.length >= 2 ? valid : null;
  } catch {
    return null;
  }
}

// ── Zone Detection ─────────────────────────────────────────────────────────

interface BasketballSignal {
  detected: boolean;
  direction: 'BUY' | 'SELL' | null;  // BUY = calls (support), SELL = puts (resistance)
  level: number;
  currentPrice: number;
  log: string;
}

/**
 * Core basketball detection:
 *   - Previous bar was OUTSIDE the zone
 *   - Current bar is INSIDE the zone
 *   - Approach direction determines call/put
 */
function detectBasketballEntry(bars: number[]): BasketballSignal {
  const fail = (log: string): BasketballSignal => ({
    detected: false, direction: null, level: 0, currentPrice: 0, log,
  });

  if (bars.length < 2) return fail('Not enough bars');

  const current = bars[bars.length - 1];
  const prev    = bars[bars.length - 2];

  const curZone  = isInBasketballZone(current);
  const prevZone = isInBasketballZone(prev);

  // Must be a FRESH entry: prev was outside, current is inside
  if (!curZone.inZone) return fail(`$${current.toFixed(2)} outside zone (nearest: $${curZone.level})`);
  if (prevZone.inZone) return fail(`Already inside zone $${curZone.level} last bar — no fresh entry`);

  // Determine approach: was price coming from below or above?
  const approachFromBelow = prev < curZone.level - ZONE_HALF_WIDTH;
  const approachFromAbove = prev > curZone.level + ZONE_HALF_WIDTH;

  if (!approachFromBelow && !approachFromAbove) {
    return fail(`Approach direction unclear (prev $${prev.toFixed(2)} vs level $${curZone.level})`);
  }

  // From below = resistance → SELL (buy PUT)
  // From above = support  → BUY (buy CALL)
  const direction: 'BUY' | 'SELL' = approachFromBelow ? 'SELL' : 'BUY';

  return {
    detected: true,
    direction,
    level: curZone.level,
    currentPrice: current,
    log: `${direction === 'SELL' ? 'Resistance' : 'Support'} zone $${curZone.level} — `
       + `price $${current.toFixed(2)} entered from ${approachFromBelow ? 'below' : 'above'} `
       + `(prev $${prev.toFixed(2)}) → ${direction === 'SELL' ? 'PUT' : 'CALL'}`,
  };
}

// ── Main Scanner ─────────────────────────────────────────────────────────────

/**
 * Run the basketball zone scan for SPY.
 * Called every 5 minutes by the scheduler between 10 AM and 3 PM ET.
 */
export async function runBasketballScan(): Promise<void> {
  // Time gate: 10 AM–3 PM ET only
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = nowET.getHours();
  if (etHour < 10 || etHour >= 15) return;

  if (!isConnected()) {
    console.log('[Basketball] IB not connected — skipping');
    return;
  }

  const sb = getSupabase();
  const todayExpiry = getTodayExpiry();
  const todayStart  = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Daily cap: max 1 0DTE basketball trade
  const { data: todayTrades } = await sb
    .from('paper_trades')
    .select('id')
    .eq('mode', 'OPTIONS_SCALP')
    .eq('option_expiry', todayExpiry)
    .gte('opened_at', todayStart.toISOString());

  if ((todayTrades ?? []).length >= MAX_TRADES_PER_DAY) {
    console.log('[Basketball] Daily cap reached — skipping');
    return;
  }

  // ATH gate: only valid when market is near 52-week high
  const quote = await finnhubFetch<{ c?: number; h52?: number; o?: number }>(
    `${FINNHUB_BASE}/quote?symbol=${TICKER}&token=${FINNHUB_KEY}`,
  );

  if (!quote?.c || !quote.h52) {
    console.log('[Basketball] SPY quote unavailable');
    return;
  }

  const spyPrice = quote.c;
  const high52   = quote.h52;

  if (spyPrice < high52 * ATH_PROXIMITY_THRESHOLD) {
    console.log(
      `[Basketball] ATH gate failed — SPY $${spyPrice.toFixed(2)} is < ${(ATH_PROXIMITY_THRESHOLD * 100).toFixed(0)}% `
      + `of 52w high $${high52.toFixed(2)} ($${(high52 * ATH_PROXIMITY_THRESHOLD).toFixed(2)} threshold)`,
    );
    return;
  }

  // Skip if we're NOT near a $5 level right now (avoids fetching bars for nothing)
  const { inZone: nearLevel, level } = isInBasketballZone(spyPrice);
  if (!nearLevel) {
    // Quick early exit with minimal logging (runs every 5 min, keep noise low)
    return;
  }

  console.log(`[Basketball] SPY $${spyPrice.toFixed(2)} in zone $${level} — checking entry pattern`);

  // Fetch recent 5-min bars for direction analysis
  const bars = await getRecentSpyBars(6);
  if (!bars) {
    console.log('[Basketball] Unable to fetch SPY bars');
    return;
  }

  const signal = detectBasketballEntry(bars);
  console.log(`[Basketball] ${signal.log}`);

  if (!signal.detected || !signal.direction) return;

  // Check no active position already open for today
  const { data: existing } = await sb
    .from('paper_trades')
    .select('id')
    .eq('mode', 'OPTIONS_SCALP')
    .eq('ticker', TICKER)
    .in('status', ['SUBMITTED', 'FILLED', 'PARTIAL'])
    .gte('opened_at', todayStart.toISOString());
  if (existing?.length) {
    console.log('[Basketball] Already have an open SPY scalp today — skipping');
    return;
  }

  const right: 'C' | 'P' = signal.direction === 'BUY' ? 'C' : 'P';

  // Find ATM strike for 0DTE
  const atm = await findAtmStrike(TICKER, right, spyPrice, todayExpiry);
  if (!atm) {
    console.log('[Basketball] No ATM 0DTE strike found — chain may not be loaded');
    return;
  }

  if (atm.bid < 0.10) {
    console.log(`[Basketball] Bid too thin ($${atm.bid}) — no fill expected`);
    return;
  }

  const limitPrice = atm.ask;
  const premiumCost = limitPrice * 100 * CONTRACTS;
  if (premiumCost > MAX_PREMIUM) {
    console.log(`[Basketball] Premium $${premiumCost.toFixed(0)} > cap $${MAX_PREMIUM} — skip`);
    return;
  }

  // Get VWAP as a context note (basketball targets VWAP, open, ORB)
  const vwapResult = await fetchVwap(TICKER).catch(() => null);
  const vwapNote   = vwapResult ? ` | VWAP target $${vwapResult.vwap.toFixed(2)}` : '';

  console.log(
    `[Basketball] Placing 0DTE ${right === 'C' ? 'CALL' : 'PUT'} $${atm.strike} `
    + `@ $${limitPrice.toFixed(2)}${vwapNote}`,
  );

  await executeBaskeball({
    right, signal: signal.direction,
    strike: atm.strike, expiry: todayExpiry,
    limitPrice, contracts: CONTRACTS,
    price: spyPrice, delta: atm.delta,
    spreadPct: atm.spreadPct,
    level: signal.level,
    vwap: vwapResult?.vwap ?? null,
    pricingSource: atm.pricingSource,
  });
}

// ── Execute ─────────────────────────────────────────────────────────────────

interface BasketballParams {
  right: 'C' | 'P';
  signal: 'BUY' | 'SELL';
  strike: number;
  expiry: string;
  limitPrice: number;
  contracts: number;
  price: number;
  delta: number;
  spreadPct: number;
  level: number;
  vwap: number | null;
  pricingSource: AtmPricingSource;
}

async function executeBaskeball(p: BasketballParams): Promise<boolean> {
  const sb      = getSupabase();
  const account = getDefaultAccount() ?? undefined;

  const zoneDesc = p.right === 'C'
    ? `Support bounce at $${p.level} zone`
    : `Resistance rejection at $${p.level} zone`;
  const targetDesc = p.vwap ? `, target VWAP $${p.vwap.toFixed(2)}` : '';

  const resolved = await resolveOptionConId(TICKER, p.right, p.strike, p.expiry);
  if (!resolved) {
    console.log(`[Basketball] No IB security definition for $${p.strike}${p.right} ${p.expiry} — skip`);
    createAutoTradeEvent({
      ticker: TICKER, event_type: 'warning', action: 'skipped', source: 'scanner', mode: 'OPTIONS_SCALP',
      message: `Basketball skipped — no IB contract for $${p.strike}${p.right} ${p.expiry}`,
      metadata: { strike: p.strike, expiry: p.expiry, pricingSource: p.pricingSource },
    }).catch(() => {});
    return false;
  }

  let limitPrice = p.limitPrice;
  let delta = p.delta;
  let liveQuote = p.pricingSource === 'live';
  if (!liveQuote) {
    const greeks = await getOptionGreeksForContract(TICKER, p.strike, resolved.resolvedExpiry, p.right, p.price);
    if (greeks && greeks.bid >= 0.10 && greeks.ask > 0) {
      limitPrice = greeks.ask;
      delta = greeks.delta;
      liveQuote = true;
    }
  }
  if (!liveQuote) {
    console.log(`[Basketball] No live quote (pricing=${p.pricingSource}) — refusing BS-only limit`);
    createAutoTradeEvent({
      ticker: TICKER, event_type: 'warning', action: 'skipped', source: 'scanner', mode: 'OPTIONS_SCALP',
      message: `Basketball skipped — no live option quote (pricing=${p.pricingSource})`,
      metadata: { strike: p.strike, expiry: resolved.resolvedExpiry, pricingSource: p.pricingSource },
    }).catch(() => {});
    return false;
  }

  let result;
  try {
    result = await placeOptionsOrder({
      symbol:     TICKER,
      right:      p.right,
      strike:     p.strike,
      expiry:     resolved.resolvedExpiry,
      contracts:  p.contracts,
      limitPrice,
      action:     'BUY',
      conId:      resolved.conId,
      ...(account ? { account } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Basketball] IB order failed:', msg);
    createAutoTradeEvent({
      ticker: TICKER, event_type: 'warning', action: 'skipped', source: 'scanner', mode: 'OPTIONS_SCALP',
      message: `Basketball skipped — IB reject: ${msg}`,
      metadata: { strike: p.strike, expiry: resolved.resolvedExpiry, conId: resolved.conId },
    }).catch(() => {});
    return false;
  }

  if (result.timedOut || !result.avgFillPrice || result.avgFillPrice <= 0) {
    if (result.orderId && isConnected()) {
      try { cancelOrder(result.orderId); } catch { /* best-effort */ }
    }
    console.log('[Basketball] SPY 0DTE — no fill');
    createAutoTradeEvent({
      ticker: TICKER, event_type: 'warning', action: 'skipped', source: 'scanner', mode: 'OPTIONS_SCALP',
      message: 'Basketball skipped — no fill (timed out)',
      metadata: { strike: p.strike, expiry: resolved.resolvedExpiry, orderId: result.orderId },
    }).catch(() => {});
    return false;
  }

  const { data: trade, error } = await sb
    .from('paper_trades')
    .insert({
      ticker:           TICKER,
      mode:             'OPTIONS_SCALP',
      signal:           p.signal,
      entry_price:      p.price,
      quantity:         p.contracts,
      position_size:    Math.round(result.avgFillPrice * 100 * p.contracts),
      status:           'FILLED',
      fill_price:       result.avgFillPrice,
      filled_at:        new Date().toISOString(),
      ib_order_id:      result.orderId,
      option_strike:    p.strike,
      option_expiry:    resolved.resolvedExpiry,
      option_premium:   result.avgFillPrice,
      option_contracts: p.contracts,
      option_delta:     delta,
      notes:            `[BASKETBALL] Buy ${p.right === 'C' ? 'call' : 'put'}: $${p.strike} 0DTE — ${zoneDesc}${targetDesc}`,
      scanner_reason:   `Basketball zone $${p.level} — δ ${Math.abs(delta).toFixed(2)}, spread ${p.spreadPct.toFixed(1)}%, SPY $${p.price.toFixed(2)}`,
    })
    .select('id')
    .single();

  if (error || !trade) {
    console.error(`[Basketball] DB insert failed AFTER fill IB #${result.orderId}:`, error?.message);
    createAutoTradeEvent({
      ticker: TICKER, event_type: 'error', action: 'failed', source: 'scanner', mode: 'OPTIONS_SCALP',
      message: `CRITICAL: basketball FILLED in IB #${result.orderId} @ $${result.avgFillPrice.toFixed(2)} but paper_trades insert failed`,
      metadata: { orderId: result.orderId, fillPrice: result.avgFillPrice, strike: p.strike, expiry: resolved.resolvedExpiry },
    }).catch(() => {});
    return false;
  }

  console.log(
    `[Basketball] ✅ SPY ${p.right === 'C' ? 'CALL' : 'PUT'} $${p.strike} 0DTE `
    + `@ $${result.avgFillPrice.toFixed(2)} | IB #${result.orderId} | ${zoneDesc}`,
  );

  createAutoTradeEvent({
    ticker:     TICKER,
    event_type: 'success',
    action:     'executed',
    source:     'scanner',
    mode:       'OPTIONS_SCALP',
    message:    `🏀 Basketball 0DTE ${p.right === 'C' ? 'CALL' : 'PUT'} $${p.strike} @ $${result.avgFillPrice.toFixed(2)} — ${zoneDesc}${targetDesc}`,
    metadata:   { strike: p.strike, expiry: resolved.resolvedExpiry, premium: result.avgFillPrice, delta, right: p.right, level: p.level, conId: resolved.conId },
  }).catch(() => {});

  return true;
}

// ── 0DTE Early Close ─────────────────────────────────────────────────────────

/**
 * Force-close any open basketball (0DTE SPY) positions at 3:30 PM ET.
 * Basketball trades are identified by ticker=SPY + option_expiry=today.
 * Runs 15 min before the regular scalp EOD (3:45 PM) to reduce assignment risk.
 */
export async function closeBasketballPositionsEod(): Promise<void> {
  const sb          = getSupabase();
  const todayExpiry = getTodayExpiry();
  const todayStart  = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: positions } = await sb
    .from('paper_trades')
    .select('id, signal, option_strike, option_expiry, option_premium, option_contracts, ib_order_id')
    .eq('mode', 'OPTIONS_SCALP')
    .eq('ticker', TICKER)            // only SPY basketball positions — not IWM/QQQ VWAP scalps
    .eq('option_expiry', todayExpiry)
    .in('status', ['FILLED', 'PARTIAL'])
    .gte('opened_at', todayStart.toISOString());

  if (!positions?.length) return;

  console.log(`[Basketball] 3:30 PM EOD — closing ${positions.length} 0DTE position(s)`);

  for (const pos of (positions as Array<{
    id: string; signal: string;
    option_strike: number; option_expiry: string;
    option_premium: number; option_contracts: number | null; ib_order_id: number | null;
  }>)) {
    const right     = pos.signal === 'BUY' ? 'C' : 'P';
    const contracts = pos.option_contracts ?? 1;

    // Get current premium for P&L calculation
    const q = await finnhubFetch<{ c?: number }>(
      `${FINNHUB_BASE}/quote?symbol=${TICKER}&token=${FINNHUB_KEY}`,
    );
    const greeks = q?.c
      ? await getOptionGreeksForContract(TICKER, pos.option_strike, pos.option_expiry, right, q.c)
      : null;
    const currentPremium = greeks?.mid ?? 0;
    const premiumPaid    = pos.option_premium ?? 0;
    const pnl            = (currentPremium - premiumPaid) * 100 * contracts;

    console.log(
      `[Basketball] EOD close ${TICKER} ${right === 'C' ? 'CALL' : 'PUT'} $${pos.option_strike} — `
      + `current $${currentPremium.toFixed(2)}, paid $${premiumPaid.toFixed(2)}, `
      + `${contracts} contract(s), P&L ≈ $${pnl.toFixed(2)}`,
    );

    // Sell via IB
    let filled = false;
    try {
      const account = getDefaultAccount() ?? undefined;
      const result  = await placeOptionsOrder({
        symbol:     TICKER,
        right,
        strike:     pos.option_strike,
        expiry:     pos.option_expiry,
        contracts,
        limitPrice: Math.max(currentPremium, 0.01),
        action:     'SELL',
        ...(account ? { account } : {}),
      });
      filled = !result.timedOut && (result.avgFillPrice ?? 0) > 0;
    } catch (err) {
      console.warn('[Basketball] IB sell failed:', err instanceof Error ? err.message : err);
    }

    // Only update DB if IB confirmed the fill — OR if premium is already $0 (will expire
    // worthless regardless; no fill is possible on a worthless 0DTE contract).
    if (!filled && currentPremium > 0) {
      console.warn(
        `[Basketball] No fill confirmed for ${TICKER} ${right} $${pos.option_strike} — `
        + 'leaving FILLED, regular scalp manager will retry at 3:45 PM',
      );
      continue;
    }

    await sb
      .from('paper_trades')
      .update({
        status:       'CLOSED',
        close_reason:  filled ? 'eod_close' : 'expired_worthless',
        closed_at:    new Date().toISOString(),
        close_price:  currentPremium,
        pnl,
      })
      .eq('id', pos.id);
  }
}
