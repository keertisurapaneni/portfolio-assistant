/**
 * Bear Put Spread Scanner
 *
 * Scans a high-beta/momentum watchlist for Bear Put Debit Spread opportunities.
 * Strategy: BUY a near-ATM put (50-60 delta) + SELL a lower OTM put (20 delta).
 * Net debit paid upfront. Profits when the underlying falls significantly.
 *
 * Entry signal (two-step):
 *   Step 1 — Scanner gates (morning scan):
 *     - RSI(14) > 70 within last 5 trading days (overbought)
 *     - Price extended above 20-day SMA
 *     - Beta > 1.2 (high-beta names snap back harder)
 *     - IVR < 50 (debit is reasonably priced)
 *     - SPY not up > 1.5% today (macro tailwind for bears)
 *     - No existing open Bear Put on same ticker
 *   Step 2 — Breakdown confirmation (required for entry):
 *     - Close < prior day low (breakdown) OR
 *     - Close < 5-day EMA (short-term momentum shift)
 *
 * Exit rules:
 *   - Profit: close when spread value ≥ debit × 1.75 (75% gain)
 *   - Stop:   close when spread value ≤ debit × 0.50 (50% loss)
 *   - Time:   close at DTE ≤ 3 (avoid assignment risk on short put)
 *
 * Strike selection: long put ≈ 50-60 delta (ATM), short put ≈ 20 delta (1σ down)
 * Target expiry: 30-60 DTE (45 DTE sweet spot)
 * Max debit: $800 per spread (1 contract)
 * Max positions: 3 simultaneous Bear Put spreads
 *
 * References: OptionsPlay webinar (Tony Zhang / Jessica Inscip), Jun 2026
 * Plan doc: docs/cursor/2026-06-17-bear-put-spread-scanner.md
 */

import { findSpreadStrikes, getOptionGreeksForContract } from './options-chain.js';
import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { recordTradeClose } from './trade-closer.js';
import { fetchDailyBars, fetchQuote } from './yahoo-finance.js';
import { isConnected, placeVerticalSpreadOrder, getDefaultAccount } from '../ib-connection.js';
import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';

// ── Watchlist ─────────────────────────────────────────────────────────────────
// High-beta, momentum, and growth stocks that tend to snap back hard when overbought.
// These are the candidates for Bear Put Debit Spreads.
// TODO: move to DB (options_watchlist.bear_put_eligible = true) once migration is applied.
const BEAR_PUT_WATCHLIST = [
  'RKLB',  // beta ~2.5, space/tech momentum
  'NVDA',  // beta ~2.0, AI bellwether, sharp reversals
  'TSLA',  // beta ~2.0, high-vol EV name
  'PLTR',  // beta ~1.8, high-beta software
  'APP',   // beta ~1.7, high-growth ad tech
  'NVDL',  // 2× NVDA ETF
  'TSLL',  // 2× TSLA ETF
  'SOXL',  // 3× semiconductors ETF
  'TQQQ',  // 3× QQQ ETF
  'ALAB',  // beta ~1.8, chip design growth name
  'SNOW',  // beta ~1.5, cloud data, volatile
  'CRDO',  // beta ~1.5, semiconductor
  'META',  // beta ~1.4, mega-cap tech
  'AMD',   // beta ~1.6, semiconductor
  'AMZN',  // beta ~1.3, mega-cap with options liquidity
  'GOOGL', // beta ~1.2, mega-cap
  'NOW',   // beta ~1.2, SaaS, sharp reversals
  'PANW',  // beta ~1.3, cybersecurity
  'RIVN',  // beta ~2.0, high-beta EV startup
  'NBIS',  // beta ~1.6, AI infrastructure
  'FIG',   // beta ~1.5, financials with momentum
  'VIK',   // beta ~1.4, growth/momentum
];

// ── Constants ─────────────────────────────────────────────────────────────────
const TARGET_DTE = 45;           // target 30–60 DTE, 45 is sweet spot
const MAX_BEAR_PUT_POSITIONS = 3;
const MAX_DEBIT_DOLLARS = 800;   // max $800 debit per 1-contract spread
const MAX_DEBIT_PCT_OF_WIDTH = 0.65; // don't pay more than 65% of spread width
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_LOOKBACK_DAYS = 5;    // RSI must have been > 70 in last 5 trading days
const MIN_BETA = 1.2;
const MAX_IVR = 50;              // debit spreads preferred when IV not too elevated
const SPY_UP_GATE_PCT = 1.5;    // skip if SPY is up > 1.5% today (bullish momentum)
const MIN_STOCK_PRICE = 20;
const PROFIT_TARGET_MULT = 1.75; // close when spread value ≥ debit × 1.75 (75% gain)
const STOP_LOSS_MULT = 0.50;     // close when spread value ≤ debit × 0.50 (50% loss)
const DTE_BACKSTOP = 3;          // force close at 3 DTE regardless

// ── Types ─────────────────────────────────────────────────────────────────────

interface BearPutTicket {
  ticker: string;
  longStrike: number;   // higher put — we BUY this (50-60 delta, near ATM)
  shortStrike: number;  // lower put  — we SELL this (20 delta, 1σ down)
  expiry: string;       // YYYYMMDD
  dte: number;
  width: number;        // longStrike - shortStrike
  netDebit: number;     // per share (we pay this to open)
  debitPct: number;     // netDebit / width
  maxGain: number;      // (width - netDebit) × 100 × contracts
  maxLoss: number;      // netDebit × 100 × contracts
  contracts: number;    // always 1 to stay within $800 max
  currentPrice: number;
  rsi: number;
  ivr: number | null;
  checksDetail: Record<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wilder's RSI using a simple rolling average (suitable for daily bars). */
function computeRSI(closes: number[], period = RSI_PERIOD): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period - 1; i < closes.length - 1; i++) {
    const change = closes[i + 1] - closes[i];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

/** Exponential moving average. */
function computeEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/** Simple moving average over last N values. */
function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (slice.length < period) return values[values.length - 1];
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function getStockQuote(ticker: string): Promise<{ price: number; pctChange: number } | null> {
  const data = await finnhubFetch<{ c: number; dp: number }>(
    `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  if (data?.c) return { price: data.c, pctChange: data.dp ?? 0 };
  const yq = await fetchQuote(ticker);
  if (yq?.price) return { price: yq.price, pctChange: 0 };
  return null;
}

async function getBeta(ticker: string): Promise<number | null> {
  const data = await finnhubFetch<{ metric?: { beta?: number } }>(
    `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`
  );
  const beta = data?.metric?.beta;
  return typeof beta === 'number' ? beta : null;
}

async function getStoredIvRank(ticker: string): Promise<number | null> {
  const sb = getSupabase();
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data } = await sb
    .from('options_iv_history')
    .select('iv')
    .eq('ticker', ticker)
    .gte('date', yearAgo)
    .order('date', { ascending: false });
  if (!data || data.length < 10) return null;
  const ivs = data.map(r => r.iv as number);
  const current = ivs[0];
  const min52w = Math.min(...ivs);
  const max52w = Math.max(...ivs);
  if (max52w === min52w) return 50;
  return Math.round(((current - min52w) / (max52w - min52w)) * 100);
}

// ── Scanner ───────────────────────────────────────────────────────────────────

async function scanTickerForBearPut(
  ticker: string,
  openBearPutTickers: Set<string>,
  spyPctChange: number,
): Promise<BearPutTicket | { ticker: string; skipped: true; reason: string }> {
  const checks: Record<string, string> = {};

  // Gate 1: No duplicate open Bear Put on same ticker
  if (openBearPutTickers.has(ticker)) {
    return { ticker, skipped: true, reason: 'duplicate_open_bear_put' };
  }

  // Gate 2: SPY direction — skip if broad market is strongly up
  if (spyPctChange > SPY_UP_GATE_PCT) {
    return { ticker, skipped: true, reason: `spy_up_${spyPctChange.toFixed(1)}pct` };
  }
  checks.spy = `${spyPctChange.toFixed(1)}%`;

  // Gate 3: Get current price
  const quote = await getStockQuote(ticker);
  if (!quote) return { ticker, skipped: true, reason: 'no_price_data' };
  const { price } = quote;
  if (price < MIN_STOCK_PRICE) return { ticker, skipped: true, reason: `price_too_low:${price}` };
  checks.price = `$${price.toFixed(2)}`;

  // Gate 4: Fetch daily bars (3 months for SMA20, RSI, EMA5)
  const bars = await fetchDailyBars(ticker, '3mo');
  if (!bars || bars.length < 25) return { ticker, skipped: true, reason: 'insufficient_bar_data' };
  const closes = bars.map(b => b.close);

  // Gate 5: RSI must have been > RSI_OVERBOUGHT within last RSI_LOOKBACK_DAYS trading days
  let foundOverbought = false;
  let latestRsi = 50;
  for (let i = Math.max(RSI_PERIOD + 1, closes.length - RSI_LOOKBACK_DAYS); i <= closes.length; i++) {
    const rsi = computeRSI(closes.slice(0, i), RSI_PERIOD);
    if (i === closes.length) latestRsi = rsi;
    if (rsi > RSI_OVERBOUGHT) { foundOverbought = true; }
  }
  if (!foundOverbought) {
    return { ticker, skipped: true, reason: `rsi_not_overbought:${latestRsi.toFixed(0)}` };
  }
  checks.rsi = `${latestRsi.toFixed(0)}_overbought_in_last_${RSI_LOOKBACK_DAYS}d`;

  // Gate 6: Price extended above 20-day SMA
  const sma20 = sma(closes, 20);
  const aboveSma20Pct = ((price - sma20) / sma20) * 100;
  if (aboveSma20Pct < 3) {
    return { ticker, skipped: true, reason: `not_extended_above_sma20:${aboveSma20Pct.toFixed(1)}%` };
  }
  checks.sma20 = `$${sma20.toFixed(2)}_extended_${aboveSma20Pct.toFixed(1)}%`;

  // Gate 7: Beta > MIN_BETA
  const beta = await getBeta(ticker);
  if (beta !== null && beta < MIN_BETA) {
    return { ticker, skipped: true, reason: `beta_too_low:${beta.toFixed(2)}` };
  }
  checks.beta = beta !== null ? `${beta.toFixed(2)}` : 'unknown_pass';

  // Gate 8: IVR < MAX_IVR (debit spreads are cheaper at lower IV)
  const ivr = await getStoredIvRank(ticker);
  if (ivr !== null && ivr > MAX_IVR) {
    return { ticker, skipped: true, reason: `ivr_too_high:${ivr}` };
  }
  checks.ivr = ivr !== null ? `${ivr}` : 'building_history';

  // Gate 9: Breakdown confirmation (at least one required)
  const ema5 = computeEMA(closes, 5);
  const priorDayLow = bars.length >= 2 ? bars[bars.length - 2].low : price;
  const belowPriorLow = price < priorDayLow;
  const belowEma5 = price < ema5;
  if (!belowPriorLow && !belowEma5) {
    return {
      ticker,
      skipped: true,
      reason: `no_breakdown_confirmation:price$${price.toFixed(2)}_prior_low$${priorDayLow.toFixed(2)}_ema5$${ema5.toFixed(2)}`,
    };
  }
  const confirmTrigger = belowPriorLow ? 'below_prior_low' : 'below_ema5';
  checks.breakdown = confirmTrigger;

  // Gate 10: Find strike pair via findSpreadStrikes
  // findSpreadStrikes returns sellStrike (ATM, ~50δ) + buyStrike (OTM, ~25δ) for a CREDIT spread.
  // For a BEAR PUT DEBIT: we BUY the ATM put (= sellStrike) + SELL the OTM put (= buyStrike).
  const strikeResult = await findSpreadStrikes(ticker, price, 'P', TARGET_DTE, 0);
  if (!strikeResult) return { ticker, skipped: true, reason: 'no_qualifying_strikes' };

  const longStrike = strikeResult.sellStrike;  // ATM put we BUY
  const shortStrike = strikeResult.buyStrike;  // OTM put we SELL
  const width = longStrike - shortStrike;

  // Debit ≈ cost to buy the spread = long put ask - short put bid
  // Approximated from BS prices: debit ≈ (long BS price) - (short BS price) with bid/ask crossing
  const netDebit = Math.max(0, (strikeResult.sellPremium + strikeResult.buyPremium * 0.1));
  // More accurate: debit = long put theoretical - short put theoretical + bid/ask slippage
  // Using available data: long put premium (sellPremium = bid of ATM for credit) ≈ ATM put value
  // Simple estimate: netDebit ≈ width - netCredit  (debit + credit = width in theory)
  const netDebitEstimate = width - strikeResult.netCredit;
  const debitPct = netDebitEstimate / width;

  if (debitPct > MAX_DEBIT_PCT_OF_WIDTH) {
    return { ticker, skipped: true, reason: `debit_too_high:${(debitPct * 100).toFixed(0)}%_of_width` };
  }

  // Gate 11: Max debit ≤ $800 for 1 contract
  const debitFor1Contract = netDebitEstimate * 100;
  if (debitFor1Contract > MAX_DEBIT_DOLLARS) {
    return { ticker, skipped: true, reason: `debit_$${debitFor1Contract.toFixed(0)}_exceeds_max_$${MAX_DEBIT_DOLLARS}` };
  }

  const contracts = 1; // always start with 1 contract
  const maxGain = (width - netDebitEstimate) * 100 * contracts;
  const maxLoss = netDebitEstimate * 100 * contracts;

  checks.strikes = `long${longStrike}/short${shortStrike}_debit$${netDebitEstimate.toFixed(2)}_width$${width}`;

  return {
    ticker,
    longStrike,
    shortStrike,
    expiry: strikeResult.expiry,
    dte: strikeResult.dte,
    width,
    netDebit: netDebitEstimate,
    debitPct,
    maxGain,
    maxLoss,
    contracts,
    currentPrice: price,
    rsi: latestRsi,
    ivr,
    checksDetail: checks,
  };
}

/**
 * Run the Bear Put Spread scan across the Bear Put watchlist.
 * Finds overbought/extended high-beta stocks showing breakdown signals
 * and places Bear Put Debit Spreads automatically.
 */
export async function runBearPutScan(autoExecute = false): Promise<void> {
  const sb = getSupabase();

  // Get currently open Bear Put positions (skip already-open tickers)
  const { data: openPositions } = await sb
    .from('paper_trades')
    .select('ticker')
    .eq('mode', 'CREDIT_SPREAD')
    .eq('spread_type', 'BEAR_PUT')
    .in('status', ['FILLED', 'PARTIAL', 'SUBMITTED']);

  const openBearPutTickers = new Set((openPositions ?? []).map(p => p.ticker));
  const openCount = openBearPutTickers.size;

  if (openCount >= MAX_BEAR_PUT_POSITIONS) {
    console.log(`[Bear Put Scanner] Max positions (${MAX_BEAR_PUT_POSITIONS}) already open — skipping scan`);
    return;
  }

  // SPY direction gate — same for all tickers
  const spyQuote = await getStockQuote('SPY');
  const spyPctChange = spyQuote?.pctChange ?? 0;

  console.log(`[Bear Put Scanner] Scanning ${BEAR_PUT_WATCHLIST.length} tickers (${openCount} open, SPY ${spyPctChange.toFixed(1)}%)...`);

  const candidates: BearPutTicket[] = [];
  const skipped: Array<{ ticker: string; reason: string }> = [];

  for (const ticker of BEAR_PUT_WATCHLIST) {
    try {
      const result = await scanTickerForBearPut(ticker, openBearPutTickers, spyPctChange);
      if ('skipped' in result) {
        skipped.push({ ticker, reason: result.reason });
        console.log(`[Bear Put Scanner] SKIP ${ticker} — ${result.reason}`);
      } else {
        candidates.push(result);
        console.log(`[Bear Put Scanner] CANDIDATE ${ticker}: long${result.longStrike}/short${result.shortStrike} exp${result.expiry} debit$${result.netDebit.toFixed(2)} RSI${result.rsi.toFixed(0)} IVR${result.ivr}`);
      }
    } catch (err) {
      console.error(`[Bear Put Scanner] Error scanning ${ticker}:`, err instanceof Error ? err.message : err);
    }
  }

  // Rank by RSI × beta (highest conviction first), take top available slots
  candidates.sort((a, b) => (b.rsi) - (a.rsi)); // simple RSI sort; beta factored in via watchlist curation
  const slotsAvailable = MAX_BEAR_PUT_POSITIONS - openCount;
  const topCandidates = candidates.slice(0, slotsAvailable);

  console.log(`[Bear Put Scanner] ${candidates.length} candidates, ${topCandidates.length} will execute`);

  if (!autoExecute || topCandidates.length === 0) return;

  // Execute top candidates
  for (const ticket of topCandidates) {
    try {
      const ibConnected = isConnected();
      if (!ibConnected) {
        console.warn(`[Bear Put Scanner] IB disconnected — cannot place Bear Put spread for ${ticket.ticker}`);
        await createAutoTradeEvent({
          ticker: ticket.ticker,
          mode: 'CREDIT_SPREAD',
          event_type: 'warning',
          action: 'skipped',
          message: `Bear Put candidate ${ticket.ticker} ${ticket.longStrike}/${ticket.shortStrike} — IB disconnected, order not placed`,
          metadata: { ticket },
        });
        continue;
      }

      // Limit price: the net debit we're willing to pay (positive for BUY order)
      const limitPrice = Math.max(0.01, Math.round(ticket.netDebit * 1.05 * 100) / 100); // +5% above estimate

      const orderResult = await placeVerticalSpreadOrder({
        symbol: ticket.ticker,
        right: 'P',
        sellStrike: ticket.shortStrike,  // the lower put we're SELLING
        buyStrike: ticket.longStrike,    // the higher put we're BUYING
        expiry: ticket.expiry,
        contracts: ticket.contracts,
        limitPrice,
        action: 'BUY',  // net debit — we're buying the spread
        account: getDefaultAccount() ?? undefined,
      });

      const orderId = orderResult.orderId;
      console.log(`[Bear Put Scanner] IB order placed: ${ticket.ticker} Bear Put ${ticket.longStrike}/${ticket.shortStrike} @ $${limitPrice} debit (order #${orderId})`);

      const expiryIso = `${ticket.expiry.slice(0, 4)}-${ticket.expiry.slice(4, 6)}-${ticket.expiry.slice(6, 8)}`;

      // Insert paper_trade record
      const { data: inserted } = await sb.from('paper_trades').insert({
        ticker: ticket.ticker,
        signal: 'SELL',
        mode: 'CREDIT_SPREAD',
        status: 'SUBMITTED',
        entry_price: ticket.netDebit,
        fill_price: null,
        quantity: ticket.contracts,
        option_contracts: ticket.contracts,
        option_expiry: expiryIso,
        spread_type: 'BEAR_PUT',
        spread_short_strike: ticket.shortStrike,
        spread_long_strike: ticket.longStrike,
        spread_net_credit: ticket.netDebit, // stores the debit in the same field (debit is positive cost)
        ib_order_id: String(orderId),
        notes: `BEAR_PUT: buy $${ticket.longStrike}/${ticket.shortStrike} exp ${expiryIso} | ${ticket.contracts}x | debit $${(ticket.netDebit * 100 * ticket.contracts).toFixed(0)} | ${ticket.checksDetail.breakdown}`,
        opened_at: new Date().toISOString(),
      }).select().single();

      await createAutoTradeEvent({
        ticker: ticket.ticker,
        mode: 'CREDIT_SPREAD',
        event_type: 'info',
        action: 'executed',
        message: `Bear Put ${ticket.longStrike}/${ticket.shortStrike} ${expiryIso} — order #${orderId} submitted @ $${limitPrice} debit | RSI ${ticket.rsi.toFixed(0)} | ${ticket.checksDetail.breakdown}`,
        metadata: {
          longStrike: ticket.longStrike,
          shortStrike: ticket.shortStrike,
          expiry: expiryIso,
          dte: ticket.dte,
          netDebit: ticket.netDebit,
          limitPrice,
          orderId,
          rsi: ticket.rsi,
          ivr: ticket.ivr,
          breakdown: ticket.checksDetail.breakdown,
          tradeId: inserted?.id,
        },
      });
    } catch (err) {
      console.error(`[Bear Put Scanner] Failed to place order for ${ticket.ticker}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── Position Manager ──────────────────────────────────────────────────────────

/**
 * Manage open Bear Put Debit Spread positions.
 * Checks profit target (75%), stop loss (50%), and DTE backstop (≤3 DTE).
 * Note: NO 21-DTE time exit — debit spreads are managed by profit/loss rules only.
 */
export async function manageBearPutPositions(): Promise<void> {
  const sb = getSupabase();

  const { data: positions } = await sb
    .from('paper_trades')
    .select('*')
    .eq('mode', 'CREDIT_SPREAD')
    .eq('spread_type', 'BEAR_PUT')
    .in('status', ['FILLED', 'PARTIAL']);

  if (!positions?.length) return;

  console.log(`[Bear Put Manager] Checking ${positions.length} open Bear Put position(s)...`);

  for (const pos of positions) {
    try {
      // Skip if close order is already in-flight
      if (pos.ib_close_order_id) {
        console.log(`[Bear Put Manager] ${pos.ticker}: close order #${pos.ib_close_order_id} in-flight — waiting for fill confirmation`);
        continue;
      }

      const debitPaid = (pos.fill_price ?? pos.spread_net_credit ?? pos.entry_price ?? 0) as number;
      const contracts = (pos.option_contracts ?? pos.quantity ?? 1) as number;
      const longStrike = pos.spread_long_strike as number;
      const shortStrike = pos.spread_short_strike as number;
      const spreadWidth = longStrike - shortStrike;

      const expiryDate = pos.option_expiry ? new Date(pos.option_expiry) : null;
      const dte = expiryDate ? Math.ceil((expiryDate.getTime() - Date.now()) / 86_400_000) : 999;

      // ── DTE backstop ──────────────────────────────────────────────────────
      if (dte <= DTE_BACKSTOP) {
        const expiryQuote = await getStockQuote(pos.ticker);
        const stockPx = expiryQuote?.price ?? null;
        let settledValue = 0;
        let closeReason = 'dte_backstop_worthless';

        if (stockPx !== null) {
          // Bear Put intrinsic: max(0, longStrike - stock) - max(0, shortStrike - stock)
          settledValue = Math.min(
            spreadWidth,
            Math.max(0, longStrike - stockPx) - Math.max(0, shortStrike - stockPx)
          );
          if (stockPx <= shortStrike) closeReason = 'dte_backstop_max_gain';
          else if (stockPx < longStrike) closeReason = 'dte_backstop_partial_gain';
          else closeReason = 'dte_backstop_worthless';
        }

        const settledPnl = (settledValue - debitPaid) * 100 * contracts;
        await recordTradeClose({
          tradeId: pos.id,
          closePrice: settledValue,
          closeReason,
          status: 'CLOSED',
          accountType: 'paper',
          overridePnl: settledPnl,
          overridePnlPct: debitPaid > 0 ? (settledPnl / (debitPaid * 100 * contracts)) * 100 : 0,
          overridePnlSource: 'estimated',
        });
        await createAutoTradeEvent({
          ticker: pos.ticker,
          mode: 'CREDIT_SPREAD',
          event_type: settledPnl >= 0 ? 'info' : 'warning',
          action: 'closed',
          message: `Bear Put ${longStrike}/${shortStrike} DTE backstop — ${closeReason} | P&L $${settledPnl.toFixed(0)}`,
          metadata: { closeReason, settledPnl, dte, stockPx },
        });
        console.log(`[Bear Put Manager] DTE BACKSTOP: ${pos.ticker} Bear Put ${longStrike}/${shortStrike} → ${closeReason} P&L $${settledPnl.toFixed(0)}`);
        continue;
      }

      // ── Get current price and spread value ────────────────────────────────
      const quote = await getStockQuote(pos.ticker);
      if (!quote) {
        console.warn(`[Bear Put Manager] ${pos.ticker}: no quote — skipping this cycle`);
        continue;
      }
      const stockPx = quote.price;

      const expiryStr = pos.option_expiry ? pos.option_expiry.replace(/-/g, '') : '';
      let currentSpreadValue = debitPaid; // default: no change
      let pricingSource: 'greeks' | 'intrinsic' = 'intrinsic';

      // Try live greeks for accurate pricing
      if (expiryStr && longStrike && shortStrike) {
        const [longGreeks, shortGreeks] = await Promise.all([
          getOptionGreeksForContract(pos.ticker, longStrike, expiryStr, 'P', stockPx).catch(() => null),
          getOptionGreeksForContract(pos.ticker, shortStrike, expiryStr, 'P', stockPx).catch(() => null),
        ]);
        if (longGreeks && shortGreeks) {
          // Sell-to-close value: sell the long leg at its bid, buy back the short leg at its ask
          const closeCredit = longGreeks.bid - shortGreeks.ask;
          currentSpreadValue = Math.max(0, closeCredit);
          pricingSource = 'greeks';
        }
      }

      if (pricingSource === 'intrinsic') {
        // Bear Put intrinsic: max(0, longStrike - stock) - max(0, shortStrike - stock) + 10% time buffer
        const intrinsic = Math.min(
          spreadWidth,
          Math.max(0, longStrike - stockPx) - Math.max(0, shortStrike - stockPx)
        );
        currentSpreadValue = intrinsic + spreadWidth * 0.10;
        console.log(`[Bear Put Manager] ${pos.ticker}: greeks unavailable, intrinsic estimate $${currentSpreadValue.toFixed(2)} (stock $${stockPx.toFixed(2)} vs ${longStrike}/${shortStrike})`);
      }

      // ── P&L calculation ───────────────────────────────────────────────────
      // For debit spread: P&L = (current value - debit paid) × 100 × contracts
      const pnlPerShare = currentSpreadValue - debitPaid;
      const pnlTotal = pnlPerShare * 100 * contracts;
      const pnlPct = debitPaid > 0 ? (pnlPerShare / debitPaid) * 100 : 0; // % of debit paid

      let closeReason: string | null = null;

      // Rule 1: Profit target — 75% gain on debit paid
      if (currentSpreadValue >= debitPaid * PROFIT_TARGET_MULT) {
        closeReason = 'profit_target_75pct';
      }

      // Rule 2: Stop loss — 50% loss of debit paid
      if (currentSpreadValue <= debitPaid * STOP_LOSS_MULT) {
        closeReason = 'stop_loss_50pct';
      }

      console.log(`[Bear Put Manager] ${pos.ticker} Bear Put ${longStrike}/${shortStrike}: stock $${stockPx.toFixed(2)} spreadVal=$${currentSpreadValue.toFixed(2)} debit=$${debitPaid.toFixed(2)} P&L=$${pnlTotal.toFixed(0)} (${pnlPct.toFixed(0)}%) ${dte}DTE [${pricingSource}]`);

      if (!closeReason) continue;

      console.log(`[Bear Put Manager] ${pos.ticker} → ${closeReason} (P&L: $${pnlTotal.toFixed(0)}, ${pnlPct.toFixed(0)}% of debit, ${dte} DTE)`);

      // ── Place sell-to-close order ─────────────────────────────────────────
      let ibCloseOrderId: number | null = null;
      const ibConnected = isConnected();

      console.log(`[Bear Put Manager] ${pos.ticker} close attempt — IB connected: ${ibConnected}`);

      if (ibConnected && longStrike && shortStrike && pos.option_expiry) {
        const closeLimit = Math.max(0.01, currentSpreadValue * 0.95); // 5% below estimate
        try {
          // Sell-to-close Bear Put: SELL the long leg (higher put), BUY back the short leg (lower put)
          const closeResult = await placeVerticalSpreadOrder({
            symbol: pos.ticker,
            right: 'P',
            sellStrike: longStrike,    // sell back the higher put we own
            buyStrike: shortStrike,    // buy back the lower put we're short
            expiry: pos.option_expiry.replace(/-/g, ''),
            contracts,
            limitPrice: closeLimit,
            action: 'SELL', // net credit — we're selling the spread back
            account: getDefaultAccount() ?? undefined,
          });
          ibCloseOrderId = closeResult.orderId;
          console.log(`[Bear Put Manager] IB sell-to-close dispatched for ${pos.ticker} (order #${ibCloseOrderId})`);

          // Pre-stamp ib_close_order_id so trigger can match fill events
          await sb.from('paper_trades').update({
            ib_close_order_id: String(ibCloseOrderId),
          }).eq('id', pos.id);
        } catch (ibErr) {
          console.warn(`[Bear Put Manager] IB sell-to-close FAILED for ${pos.ticker}: ${ibErr instanceof Error ? ibErr.message : ibErr}`);
        }
      }

      if (!ibCloseOrderId) {
        if (ibConnected) {
          // Order placement failed — retry next cycle
          await createAutoTradeEvent({
            ticker: pos.ticker,
            mode: 'CREDIT_SPREAD',
            event_type: 'warning',
            action: 'skipped',
            message: `Bear Put ${longStrike}/${shortStrike} ${closeReason} triggered but IB close order failed — retrying next cycle`,
            metadata: { closeReason, pnl: pnlTotal, dte },
          });
        } else {
          // IB disconnected — record estimated close
          await recordTradeClose({
            tradeId: pos.id,
            closePrice: currentSpreadValue,
            closeReason,
            status: 'CLOSED',
            accountType: 'paper',
            overridePnl: pnlTotal,
            overridePnlPct: debitPaid > 0 ? (pnlTotal / (debitPaid * 100 * contracts)) * 100 : 0,
            overridePnlSource: 'estimated',
          });
          await createAutoTradeEvent({
            ticker: pos.ticker,
            mode: 'CREDIT_SPREAD',
            event_type: 'warning',
            action: 'closed',
            message: `Bear Put ${longStrike}/${shortStrike} ${closeReason} — IB disconnected, estimated close P&L $${pnlTotal.toFixed(0)}`,
            metadata: { closeReason, pnl: pnlTotal, dte, pricingSource },
          });
        }
        continue;
      }

      // IB order placed — wait for trigger to confirm via ib_fills
      await createAutoTradeEvent({
        ticker: pos.ticker,
        mode: 'CREDIT_SPREAD',
        event_type: 'info',
        action: 'proceeding',
        message: `Bear Put ${longStrike}/${shortStrike} sell-to-close order #${ibCloseOrderId} placed (${closeReason}, est P&L $${pnlTotal.toFixed(0)}) — waiting for fill`,
        metadata: { closeReason, estimatedPnl: pnlTotal, dte, ibCloseOrderId, pricingSource },
      });
    } catch (err) {
      console.error(`[Bear Put Manager] Error managing ${pos.ticker}:`, err);
    }
  }
}
