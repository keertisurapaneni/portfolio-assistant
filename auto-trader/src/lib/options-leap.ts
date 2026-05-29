/**
 * OPTIONS_LEAP — Long-term equity anticipation securities strategy.
 *
 * Strategy (long-term, weeks/months hold):
 *   - Buy ITM/ATM calls on conviction stocks with 12–18 month expiry
 *   - Entry gates: IV rank < 40 (buy cheap), RSI oversold preferred,
 *     not within 14 days of earnings, stock at/near support (not ATH)
 *   - Strike: deep ITM (δ 0.70–0.80) for safety, ATM (δ 0.50) for balance
 *   - Max $2,500 premium per contract; total LEAP exposure ≤ 10% of account
 *   - Exit rules:
 *       • +100% gain (premium doubles) → take profit
 *       • Stock drops >20% from entry → thesis broken, close
 *       • DTE < 90 days → roll or close
 *       • Weekly check (not daily — LEAPs are long-term)
 *
 * This is capital-efficient directional exposure: controls 100 shares for
 * 20–25% of the cost. The freed capital can work in the wheel simultaneously.
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { isConnected, placeOptionsOrder, getDefaultAccount } from '../ib-connection.js';
import { getOptionsChain } from './options-chain.js';
import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';

// ── Constants ────────────────────────────────────────────
const LEAP_TARGET_DTE         = 365;    // target ~1 year out
const LEAP_MIN_DTE            = 300;    // don't accept < 300 days
const LEAP_EXIT_DTE           = 90;     // roll/close when < 90 DTE remaining
const LEAP_DELTA_TARGET       = 0.72;   // deep ITM — moves closely with stock
const LEAP_MAX_PREMIUM        = 2_500;  // max $2,500 per contract
const LEAP_PORTFOLIO_CAP_PCT  = 0.10;   // total LEAP exposure ≤ 10% of account
const LEAP_ACCOUNT_SIZE       = 100_000;// approximate account size for cap calc
const LEAP_PROFIT_MULT        = 2.0;    // take profit when premium doubles
const LEAP_THESIS_BREAK_PCT   = -20;    // close if stock drops >20% from entry
const MAX_IV_RANK_TO_ENTER    = 30;     // IV rank < 30 = genuinely cheap premiums (was 40, tightened)
const DAILY_RSI_OVERSOLD      = 45;     // daily RSI must be ≤ 45 (oversold or approaching)
const WEEKLY_RSI_OVERSOLD     = 50;     // weekly RSI must be ≤ 50 (confirming on higher timeframe)
const EARNINGS_BLACKOUT_DAYS  = 14;     // skip if earnings within 14 days
const MAX_OPTION_SPREAD_PCT   = 0.05;   // bid-ask spread ≤ 5% of mid (liquid chain required)

// ── Helpers ──────────────────────────────────────────────

/** Return the YYYYMMDD Friday approximately `targetDte` days out. */
function getLeapExpiry(targetDte = LEAP_TARGET_DTE): string {
  const now = new Date();
  const target = new Date(now.getTime() + targetDte * 86_400_000);
  // Advance to nearest Friday on or after target date
  const day = target.getDay(); // 0=Sun, 5=Fri
  const daysToFriday = day <= 5 ? 5 - day : 6; // if Sun=0 → +5, Sat=6 → +6
  target.setDate(target.getDate() + daysToFriday);
  const y  = target.getFullYear();
  const mo = String(target.getMonth() + 1).padStart(2, '0');
  const d  = String(target.getDate()).padStart(2, '0');
  return `${y}${mo}${d}`;
}

function daysToExpiry(expiryYYYYMMDD: string): number {
  const y = parseInt(expiryYYYYMMDD.slice(0, 4), 10);
  const m = parseInt(expiryYYYYMMDD.slice(4, 6), 10) - 1;
  const d = parseInt(expiryYYYYMMDD.slice(6, 8), 10);
  return Math.ceil((new Date(y, m, d).getTime() - Date.now()) / 86_400_000);
}

async function getIvRank(ticker: string): Promise<number | null> {
  const { getSupabase: sb2 } = await import('./supabase.js');
  const { data } = await sb2().from('options_scan_results')
    .select('iv_rank')
    .eq('ticker', ticker)
    .order('scan_date', { ascending: false })
    .limit(1)
    .single();
  return (data as { iv_rank?: number | null } | null)?.iv_rank ?? null;
}

async function getEarningsDays(ticker: string): Promise<number | null> {
  const data = await finnhubFetch<{ earningsCalendar?: Array<{ date?: string }> }>(
    `https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&token=${FINNHUB_KEY}`,
  );
  const entries = data?.earningsCalendar ?? [];
  const future = entries
    .map(e => e.date ? Math.ceil((new Date(e.date).getTime() - Date.now()) / 86_400_000) : null)
    .filter((d): d is number => d !== null && d > 0)
    .sort((a, b) => a - b);
  return future[0] ?? null;
}

/** Fetch RSI on daily AND weekly timeframe — both must confirm oversold for LEAP entry. */
async function getRsiMultiTimeframe(ticker: string): Promise<{ daily: number | null; weekly: number | null }> {
  const from = Math.floor(Date.now() / 1000) - 86400 * 365;
  const to   = Math.floor(Date.now() / 1000);

  const [dailyData, weeklyData] = await Promise.all([
    finnhubFetch<{ rsi?: number[] }>(
      `https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=D&from=${from}&to=${to}&indicator=rsi&timeperiod=14&token=${FINNHUB_KEY}`,
    ),
    finnhubFetch<{ rsi?: number[] }>(
      `https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=W&from=${from}&to=${to}&indicator=rsi&timeperiod=14&token=${FINNHUB_KEY}`,
    ),
  ]);

  const dailyArr  = (dailyData?.rsi  ?? []).filter(v => v != null && v > 0);
  const weeklyArr = (weeklyData?.rsi ?? []).filter(v => v != null && v > 0);

  return {
    daily:  dailyArr.length  ? dailyArr[dailyArr.length - 1]   : null,
    weekly: weeklyArr.length ? weeklyArr[weeklyArr.length - 1] : null,
  };
}

// ── Total LEAP exposure across open positions ─────────────

async function currentLeapExposure(): Promise<number> {
  const sb = getSupabase();
  const { data } = await sb
    .from('paper_trades')
    .select('position_size')
    .eq('mode', 'OPTIONS_LEAP')
    .in('status', ['SUBMITTED', 'FILLED', 'PARTIAL']);
  return (data ?? []).reduce((s, r) => s + ((r as { position_size?: number }).position_size ?? 0), 0);
}

// ── Scan ─────────────────────────────────────────────────

/**
 * Weekly LEAP scanner — runs Monday 10:30 AM ET.
 * Scans HIGH_VOL + GROWTH watchlist tickers for new LEAP entries.
 */
export async function runLeapScan(): Promise<void> {
  const sb = getSupabase();

  if (!isConnected()) {
    console.log('[LEAP] IB not connected — skipping scan');
    return;
  }

  // Portfolio cap check
  const exposure = await currentLeapExposure();
  const cap = LEAP_ACCOUNT_SIZE * LEAP_PORTFOLIO_CAP_PCT;
  if (exposure >= cap) {
    console.log(`[LEAP] Portfolio cap reached ($${exposure.toFixed(0)} / $${cap.toFixed(0)}) — skipping scan`);
    return;
  }

  const { data: watchlist } = await sb
    .from('options_watchlist')
    .select('ticker, tier')
    .eq('active', true)
    .in('tier', ['HIGH_VOL', 'GROWTH']);
  if (!watchlist?.length) return;

  const expiry = getLeapExpiry(LEAP_TARGET_DTE);
  const expDte  = daysToExpiry(expiry);
  if (expDte < LEAP_MIN_DTE) {
    console.log(`[LEAP] Nearest LEAP expiry ${expiry} only ${expDte} DTE — too short, skipping`);
    return;
  }

  console.log(`[LEAP] Scanning ${watchlist.length} tickers | target expiry ${expiry} (${expDte} DTE) | budget $${(cap - exposure).toFixed(0)} remaining`);

  for (const { ticker } of (watchlist as Array<{ ticker: string; tier: string }>)) {
    const remainingBudget = cap - (await currentLeapExposure());
    if (remainingBudget < LEAP_MAX_PREMIUM) break;

    // Skip if already have a LEAP on this ticker
    const { data: existing } = await sb
      .from('paper_trades')
      .select('id')
      .eq('mode', 'OPTIONS_LEAP')
      .eq('ticker', ticker)
      .in('status', ['SUBMITTED', 'FILLED', 'PARTIAL']);
    if (existing?.length) continue;

    // Gate 1: IV rank < 30 — only buy genuinely cheap premiums
    // (tighter than the wheel's sell gate of 50 — buying requires IV on sale)
    const ivRank = await getIvRank(ticker);
    if (ivRank !== null && ivRank > MAX_IV_RANK_TO_ENTER) {
      console.log(`[LEAP] ${ticker}: IV rank ${ivRank} > ${MAX_IV_RANK_TO_ENTER} — too expensive, skip`);
      continue;
    }

    // Gate 2: No earnings within 14 days
    const earningsDays = await getEarningsDays(ticker);
    if (earningsDays !== null && earningsDays <= EARNINGS_BLACKOUT_DAYS) {
      console.log(`[LEAP] ${ticker}: earnings in ${earningsDays} days — skip`);
      continue;
    }

    // Gate 3: RSI oversold on BOTH daily AND weekly — both timeframes must confirm.
    // This is the key discipline: don't buy just because the daily dipped, wait for
    // the weekly to also confirm. Prevents catching a falling knife mid-trend.
    const rsiData = await getRsiMultiTimeframe(ticker);
    const { daily: rsiDaily, weekly: rsiWeekly } = rsiData;

    if (rsiDaily !== null && rsiDaily > DAILY_RSI_OVERSOLD) {
      console.log(`[LEAP] ${ticker}: daily RSI ${rsiDaily.toFixed(1)} > ${DAILY_RSI_OVERSOLD} — not oversold yet, skip`);
      continue;
    }
    if (rsiWeekly !== null && rsiWeekly > WEEKLY_RSI_OVERSOLD) {
      console.log(`[LEAP] ${ticker}: weekly RSI ${rsiWeekly.toFixed(1)} > ${WEEKLY_RSI_OVERSOLD} — weekly not confirming, skip`);
      continue;
    }

    // Get quote
    const q = await finnhubFetch<{ c?: number; dp?: number; h52?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`,
    );
    if (!q?.c) continue;
    const price = q.c;

    // Gate 4: Not within 5% of 52-week high — need meaningful support, not ATH
    if (q.h52 && price >= q.h52 * 0.95) {
      console.log(`[LEAP] ${ticker}: within 5% of 52w high ($${q.h52.toFixed(0)}) — wait for pullback`);
      continue;
    }

    // Get deep ITM call (δ ~0.70–0.80) with 365 DTE
    const chain = await getOptionsChain(ticker, price, ivRank, LEAP_DELTA_TARGET, LEAP_TARGET_DTE);
    if (!chain?.bestCall) {
      console.log(`[LEAP] ${ticker}: no options chain / no ITM call found`);
      continue;
    }

    const call = chain.bestCall;
    const premium = call.ask;
    const premiumCost = premium * 100;

    if (premiumCost > LEAP_MAX_PREMIUM) {
      console.log(`[LEAP] ${ticker}: premium $${premiumCost.toFixed(0)} > cap $${LEAP_MAX_PREMIUM} — skip`);
      continue;
    }

    if (premium <= 0 || call.bid <= 0) {
      console.log(`[LEAP] ${ticker}: no real bid on ITM call — skip`);
      continue;
    }

    // Gate 5: Liquid options chain — spread must be tight (≤5% of mid)
    // Illiquid options = wide spreads = bad fills and inflated cost basis.
    const mid = (call.bid + call.ask) / 2;
    const spreadPct = mid > 0 ? (call.ask - call.bid) / mid : 1;
    if (spreadPct > MAX_OPTION_SPREAD_PCT) {
      console.log(`[LEAP] ${ticker}: spread ${(spreadPct * 100).toFixed(1)}% > ${MAX_OPTION_SPREAD_PCT * 100}% — illiquid, skip`);
      continue;
    }

    console.log(`[LEAP] ${ticker}: all gates passed | daily RSI ${rsiDaily?.toFixed(1) ?? 'n/a'} / weekly RSI ${rsiWeekly?.toFixed(1) ?? 'n/a'} | IV rank ${ivRank ?? 'n/a'} | spread ${(spreadPct * 100).toFixed(1)}% | $${call.strike}C @ $${premium.toFixed(2)}`);

    await executeLeap({
      ticker, price, call,
      expiry: call.expiry ?? expiry,
      premium, premiumCost,
      ivRank, rsi: rsiDaily,
    });
  }

  console.log('[LEAP] Scan complete');
}

// ── Execute ──────────────────────────────────────────────

interface LeapParams {
  ticker: string;
  price: number;
  call: { strike: number; delta: number; bid: number; ask: number; mid: number };
  expiry: string;
  premium: number;
  premiumCost: number;
  ivRank: number | null;
  rsi: number | null;
}

async function executeLeap(p: LeapParams): Promise<void> {
  const sb = getSupabase();
  const account = getDefaultAccount() ?? undefined;

  const { data: trade, error } = await sb
    .from('paper_trades')
    .insert({
      ticker:           p.ticker,
      mode:             'OPTIONS_LEAP',
      signal:           'BUY',
      entry_price:      p.price,
      quantity:         1,
      position_size:    Math.round(p.premiumCost),
      status:           'SUBMITTED',
      option_strike:    p.call.strike,
      option_expiry:    p.expiry,
      option_premium:   0,
      option_contracts: 1,
      option_delta:     p.call.delta,
      notes:            `[LEAP] Buy call: $${p.call.strike} exp ${p.expiry} (${daysToExpiry(p.expiry)}d) — δ${p.call.delta.toFixed(2)}, IV rank ${p.ivRank ?? 'n/a'}, RSI ${p.rsi?.toFixed(0) ?? 'n/a'}`,
      scanner_reason:   `LEAP — δ${p.call.delta.toFixed(2)}, ${daysToExpiry(p.expiry)}d, IV rank ${p.ivRank ?? 'n/a'}${p.rsi ? `, RSI ${p.rsi.toFixed(0)}` : ''}`,
    })
    .select('id')
    .single();

  if (error || !trade) {
    console.error(`[LEAP] DB insert failed for ${p.ticker}:`, error?.message);
    return;
  }

  let result;
  try {
    result = await placeOptionsOrder({
      symbol:     p.ticker,
      right:      'C',
      strike:     p.call.strike,
      expiry:     p.expiry,
      contracts:  1,
      limitPrice: p.premium,
      action:     'BUY',
      ...(account ? { account } : {}),
    });
  } catch (err) {
    console.error(`[LEAP] IB order failed for ${p.ticker}:`, err instanceof Error ? err.message : err);
    await sb.from('paper_trades').update({
      status: 'CANCELLED', close_reason: 'ib_error', closed_at: new Date().toISOString(),
    }).eq('id', trade.id);
    return;
  }

  if (result.timedOut || !result.avgFillPrice || result.avgFillPrice <= 0) {
    await sb.from('paper_trades').update({
      status: 'CANCELLED', close_reason: 'no_fill', closed_at: new Date().toISOString(),
    }).eq('id', trade.id);
    console.log(`[LEAP] ${p.ticker} — no fill`);
    return;
  }

  await sb.from('paper_trades').update({
    ib_order_id:    result.orderId,
    status:         'FILLED',
    fill_price:     result.avgFillPrice,
    option_premium: result.avgFillPrice,
    filled_at:      new Date().toISOString(),
  }).eq('id', trade.id);

  console.log(`[LEAP] ✅ ${p.ticker} CALL $${p.call.strike} exp ${p.expiry} @ $${result.avgFillPrice.toFixed(2)} | IB #${result.orderId}`);

  createAutoTradeEvent({
    ticker:     p.ticker,
    event_type: 'success',
    action:     'executed',
    source:     'scanner',
    mode:       'OPTIONS_LEAP',
    message:    `📈 LEAP CALL $${p.call.strike} exp ${p.expiry} (${daysToExpiry(p.expiry)}d) @ $${result.avgFillPrice.toFixed(2)} — δ${p.call.delta.toFixed(2)}, IV rank ${p.ivRank ?? 'n/a'}`,
    metadata:   { strike: p.call.strike, expiry: p.expiry, premium: result.avgFillPrice, delta: p.call.delta, ivRank: p.ivRank },
  }).catch(() => {});
}

// ── Position Management ───────────────────────────────────

/**
 * Weekly LEAP position check — runs every Monday.
 * Manages open LEAPs: take profit, thesis-break exit, DTE roll alert.
 */
export async function manageLeapPositions(): Promise<void> {
  const sb = getSupabase();

  const { data: positions } = await sb
    .from('paper_trades')
    .select('id, ticker, entry_price, option_strike, option_expiry, option_premium, ib_order_id')
    .eq('mode', 'OPTIONS_LEAP')
    .in('status', ['FILLED', 'PARTIAL']);

  if (!positions?.length) return;

  console.log(`[LEAP] Managing ${positions.length} open LEAP position(s)`);

  for (const pos of (positions as Array<{
    id: string; ticker: string; entry_price: number;
    option_strike: number; option_expiry: string;
    option_premium: number; ib_order_id: number | null;
  }>)) {
    const premiumPaid = pos.option_premium ?? 0;
    if (premiumPaid <= 0) continue;

    const dte = daysToExpiry(pos.option_expiry);

    // Get current stock price
    const q = await finnhubFetch<{ c?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB_KEY}`,
    );
    if (!q?.c) continue;
    const currentPrice = q.c;

    // Get current option value from IB chain
    const chain = await getOptionsChain(pos.ticker, currentPrice, null, LEAP_DELTA_TARGET, dte);
    const currentPremium = chain?.bestCall?.mid ?? null;

    if (currentPremium !== null) {
      const pnl = (currentPremium - premiumPaid) * 100;
      await sb.from('paper_trades').update({ pnl }).eq('id', pos.id);
    }

    const entryStockPrice = pos.entry_price;
    const stockChangePct  = ((currentPrice - entryStockPrice) / entryStockPrice) * 100;

    // Exit 1: Profit target — premium doubled
    if (currentPremium !== null && currentPremium >= premiumPaid * LEAP_PROFIT_MULT) {
      console.log(`[LEAP] ${pos.ticker} — profit target hit (+${((currentPremium / premiumPaid - 1) * 100).toFixed(0)}%)`);
      await closeLeap(pos.id, pos.ticker, pos.option_strike, pos.option_expiry, currentPremium, premiumPaid, 'profit_target');
      continue;
    }

    // Exit 2: Thesis broken — stock down >20% from entry
    if (stockChangePct <= LEAP_THESIS_BREAK_PCT) {
      console.log(`[LEAP] ${pos.ticker} — thesis broken (stock ${stockChangePct.toFixed(1)}% from entry $${entryStockPrice.toFixed(2)})`);
      await closeLeap(pos.id, pos.ticker, pos.option_strike, pos.option_expiry, currentPremium ?? 0, premiumPaid, 'thesis_broken');
      continue;
    }

    // Exit 3: DTE < 90 — time to roll or close
    if (dte <= LEAP_EXIT_DTE) {
      console.log(`[LEAP] ${pos.ticker} — DTE ${dte} < ${LEAP_EXIT_DTE}, needs roll or close`);
      createAutoTradeEvent({
        ticker:     pos.ticker,
        event_type: 'warning',
        action:     'skipped',
        source:     'scanner',
        mode:       'OPTIONS_LEAP',
        message:    `⚠️ LEAP ${pos.ticker} $${pos.option_strike} — only ${dte} DTE remaining. Review: roll to new expiry or close position.`,
        metadata:   { dte, strike: pos.option_strike, expiry: pos.option_expiry, currentPremium, premiumPaid },
      }).catch(() => {});
      continue;
    }

    console.log(`[LEAP] ${pos.ticker} — holding | stock ${stockChangePct > 0 ? '+' : ''}${stockChangePct.toFixed(1)}% from entry | ${dte} DTE | P&L ${currentPremium !== null ? (((currentPremium - premiumPaid) / premiumPaid) * 100).toFixed(0) + '%' : 'n/a'}`);
  }
}

// ── Close Helper ─────────────────────────────────────────

async function closeLeap(
  tradeId: string,
  ticker: string,
  strike: number,
  expiry: string,
  closePremium: number,
  premiumPaid: number,
  reason: string,
): Promise<void> {
  const sb = getSupabase();
  const account = getDefaultAccount() ?? undefined;

  const pnl = (closePremium - premiumPaid) * 100;

  if (isConnected() && closePremium > 0) {
    try {
      await placeOptionsOrder({
        symbol:    ticker,
        right:     'C',
        strike,
        expiry,
        contracts: 1,
        limitPrice: closePremium,
        action:    'SELL',
        ...(account ? { account } : {}),
      });
    } catch (err) {
      console.error(`[LEAP] Close order failed for ${ticker}:`, err instanceof Error ? err.message : err);
    }
  }

  await sb.from('paper_trades').update({
    status:       'CLOSED',
    close_reason: reason,
    close_price:  closePremium,
    closed_at:    new Date().toISOString(),
    pnl,
  }).eq('id', tradeId);

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
  console.log(`[LEAP] ${ticker} closed [${reason}] @ $${closePremium.toFixed(2)} | P&L ${pnlStr}`);

  createAutoTradeEvent({
    ticker,
    event_type: pnl >= 0 ? 'success' : 'warning',
    action:     'closed',
    source:     'scanner',
    mode:       'OPTIONS_LEAP',
    message:    `${pnl >= 0 ? '✅' : '🛑'} LEAP ${ticker} $${strike} closed [${reason}] @ $${closePremium.toFixed(2)} | P&L ${pnlStr}`,
    metadata:   { reason, pnl, closePremium, premiumPaid },
  }).catch(() => {});
}
