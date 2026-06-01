/**
 * Pre-Session ORB (Opening Range Breakout) Scanner
 *
 * Runs nightly after market close (~4:15 PM ET). For each ticker in the
 * universe, computes key levels from the prior day's price action and stores
 * conditional bracket setups for the next trading day:
 *
 *   BUY  if price breaks ABOVE prior day high + buffer → with-trend momentum
 *   SELL if price breaks BELOW prior day low  - buffer → with-trend breakdown
 *
 * Inspired by Somesh's nightly bracket approach: levels are defined from prior
 * day structure, not from intraday RSI/MACD noise.
 *
 * At market open, checkPresessionTriggers() polls every 2 min (9:30–10:30 AM).
 * A setup only executes when:
 *   1. Price crosses the trigger level
 *   2. RVOL >= 1.2x (institutional volume confirmation)
 *   3. 4H trend aligns with signal direction
 */

import { fetchDailyBars, fetchQuote } from './yahoo-finance.js';
import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';
import { getSupabase } from './supabase.js';
import { checkTrendFilter } from './trend-filter.js';

const LOG_PREFIX = '[PresessionScan]';
const log = (...args: unknown[]) => console.log(LOG_PREFIX, ...args);

// Liquid day-trade universe — high volume, institutionally traded
const ORB_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD',
  'PLTR', 'NFLX', 'COIN', 'ARM', 'AVGO', 'CRM', 'UBER', 'SHOP',
  'MU', 'PYPL', 'SMH', 'QQQ', 'SPY', 'RKLB', 'HOOD', 'APP',
  'SNOW', 'PANW', 'NOW', 'DOCU', 'AMAT', 'ASML',
];

// Minimum prior-day RVOL to be worth scanning (avoids dead stocks)
const MIN_PRIOR_RVOL = 0.8;

// Breakout buffer: price must clear prior high/low by this % to avoid false breaks
const BREAKOUT_BUFFER_PCT = 0.002; // 0.2%

// Risk:Reward targets
const RR_T1 = 2.0;  // T1 = 1:2
const RR_T2 = 3.0;  // T2 = 1:3

// RVOL gate applied at execution time (not scan time)
export const MIN_EXEC_RVOL = 1.2;

// Only scan tickers with prior day price range >= this %
const MIN_DAY_RANGE_PCT = 0.008; // 0.8%

interface PresessionSetup {
  ticker: string;
  trade_date: string;
  signal: 'BUY' | 'SELL';
  trigger_price: number;
  stop_loss: number;
  take_profit1: number;
  take_profit2: number;
  prior_day_high: number;
  prior_day_low: number;
  prior_day_close: number;
  prior_day_volume: number;
  avg_volume_10d: number | null;
  rvol: number | null;
  trend_4h: string | null;
  ema100_4h: number | null;
  atr: number;
  reason: string;
}

/** Fetch 10-day average volume from Finnhub metrics */
async function fetch10dAvgVolume(ticker: string): Promise<number | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const data = await finnhubFetch<{ metric?: { '10DayAverageTradingVolume'?: number } }>(
      `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`
    );
    const avg = data?.metric?.['10DayAverageTradingVolume'];
    return avg ? avg * 1_000_000 : null;
  } catch { return null; }
}

/** Compute ATR from last 14 daily bars */
function computeAtr(bars: { high: number; low: number; close: number }[]): number {
  if (bars.length < 2) return 0;
  const last14 = bars.slice(-15);
  const trs: number[] = [];
  for (let i = 1; i < last14.length; i++) {
    const prev = last14[i - 1];
    const cur = last14[i];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close),
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** Next trading date string (YYYY-MM-DD) in ET — avoids toISOString() UTC drift */
function nextTradingDate(): string {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = todayET.split('-').map(Number);
  // Build a pure local-time Date (no timezone offset) so getDay() is reliable
  const date = new Date(y, m - 1, d + 1);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Nightly scan — runs at ~4:15 PM ET after market close.
 * Generates ORB bracket setups for tomorrow and upserts into pre_session_setups.
 */
export async function runNightlyPresessionScan(): Promise<void> {
  const tradeDate = nextTradingDate();
  log(`Starting nightly ORB scan for ${tradeDate} — ${ORB_UNIVERSE.length} tickers`);

  const sb = getSupabase();
  const setups: PresessionSetup[] = [];
  const BATCH = 5;

  for (let i = 0; i < ORB_UNIVERSE.length; i += BATCH) {
    const batch = ORB_UNIVERSE.slice(i, i + BATCH);
    await Promise.all(batch.map(async (ticker) => {
      try {
        // ── 1. Fetch prior day bars ──────────────────────────────────────
        const bars = await fetchDailyBars(ticker, '3mo');
        if (!bars || bars.length < 15) {
          log(`  ${ticker}: skip — insufficient bars`);
          return;
        }

        const prev = bars[bars.length - 1]; // most recent completed day
        const { high: pdh, low: pdl, close: pdc, volume: pdv } = prev;

        // Day range filter — skip flat / illiquid days
        const dayRangePct = (pdh - pdl) / pdc;
        if (dayRangePct < MIN_DAY_RANGE_PCT) {
          log(`  ${ticker}: skip — day range too small (${(dayRangePct * 100).toFixed(2)}%)`);
          return;
        }

        // ── 2. Volume / RVOL ────────────────────────────────────────────
        const avg10d = await fetch10dAvgVolume(ticker);
        const rvol = avg10d && avg10d > 0 ? pdv / avg10d : null;
        if (rvol !== null && rvol < MIN_PRIOR_RVOL) {
          log(`  ${ticker}: skip — low prior RVOL (${rvol.toFixed(2)}x)`);
          return;
        }

        // ── 3. ATR ──────────────────────────────────────────────────────
        const atr = computeAtr(bars);
        if (atr <= 0) return;

        // ── 4. 4H trend ─────────────────────────────────────────────────
        const [buyTrend, sellTrend] = await Promise.all([
          checkTrendFilter(ticker, 'BUY').catch(() => ({ pass: false, ema100: null })),
          checkTrendFilter(ticker, 'SELL').catch(() => ({ pass: false, ema100: null })),
        ]);
        const trend4h = buyTrend.pass ? 'up' : sellTrend.pass ? 'down' : 'neutral';
        const ema100_4h = (buyTrend as { ema100?: number | null }).ema100
          ?? (sellTrend as { ema100?: number | null }).ema100
          ?? null;

        // ── 5. Generate setups ───────────────────────────────────────────
        const buffer = pdc * BREAKOUT_BUFFER_PCT;

        // BUY setup: price breaks above prior day high (bullish ORB)
        if (trend4h !== 'down') {
          const trigger = pdh + buffer;
          const stop    = pdh - atr * 0.8;   // stop just below prior day high
          const risk    = trigger - stop;
          if (risk > 0) {
            setups.push({
              ticker, trade_date: tradeDate, signal: 'BUY',
              trigger_price:  Math.round(trigger * 100) / 100,
              stop_loss:      Math.round(stop * 100) / 100,
              take_profit1:   Math.round((trigger + risk * RR_T1) * 100) / 100,
              take_profit2:   Math.round((trigger + risk * RR_T2) * 100) / 100,
              prior_day_high: pdh, prior_day_low: pdl, prior_day_close: pdc,
              prior_day_volume: pdv, avg_volume_10d: avg10d, rvol,
              trend_4h: trend4h, ema100_4h, atr: Math.round(atr * 100) / 100,
              reason: `ORB BUY: break above prior day high $${pdh.toFixed(2)} | ATR $${atr.toFixed(2)} | trend: ${trend4h} | RVOL: ${rvol?.toFixed(2) ?? 'n/a'}x`,
            });
          }
        }

        // SELL setup: price breaks below prior day low (bearish ORB)
        if (trend4h !== 'up') {
          const trigger = pdl - buffer;
          const stop    = pdl + atr * 0.8;   // stop just above prior day low
          const risk    = stop - trigger;
          if (risk > 0) {
            setups.push({
              ticker, trade_date: tradeDate, signal: 'SELL',
              trigger_price:  Math.round(trigger * 100) / 100,
              stop_loss:      Math.round(stop * 100) / 100,
              take_profit1:   Math.round((trigger - risk * RR_T1) * 100) / 100,
              take_profit2:   Math.round((trigger - risk * RR_T2) * 100) / 100,
              prior_day_high: pdh, prior_day_low: pdl, prior_day_close: pdc,
              prior_day_volume: pdv, avg_volume_10d: avg10d, rvol,
              trend_4h: trend4h, ema100_4h, atr: Math.round(atr * 100) / 100,
              reason: `ORB SELL: break below prior day low $${pdl.toFixed(2)} | ATR $${atr.toFixed(2)} | trend: ${trend4h} | RVOL: ${rvol?.toFixed(2) ?? 'n/a'}x`,
            });
          }
        }

        log(`  ${ticker}: ✓ ${trend4h} | PDH $${pdh.toFixed(2)} PDL $${pdl.toFixed(2)} | RVOL ${rvol?.toFixed(2) ?? 'n/a'}x`);
      } catch (err) {
        log(`  ${ticker}: error — ${err}`);
      }
    }));

    if (i + BATCH < ORB_UNIVERSE.length) await new Promise(r => setTimeout(r, 500));
  }

  if (setups.length === 0) {
    log('No setups generated — nothing to upsert');
    return;
  }

  // Insert setups; ignore conflicts so a re-run never overwrites TRIGGERED/EXPIRED rows.
  const { error } = await sb
    .from('pre_session_setups')
    .upsert(setups, { onConflict: 'ticker,trade_date,signal', ignoreDuplicates: true });

  if (error) {
    log(`ERROR upserting setups: ${error.message}`);
  } else {
    log(`✓ Upserted ${setups.length} ORB setups for ${tradeDate}`);
  }
}

export interface OrbTrigger {
  setupId:      string;
  ticker:       string;
  signal:       'BUY' | 'SELL';
  price:        number;   // live price at trigger time
  stopLoss:     number;
  takeProfit1:  number;
  takeProfit2:  number | null;
  liveRvol:     number | null;
  reason:       string;
}

/**
 * Morning trigger checker — runs every 2 min from 9:30–10:30 AM ET.
 * Returns setups whose price + RVOL conditions are met. Caller (scheduler)
 * handles execution via executeScannerTrade() to avoid circular imports.
 */
export async function checkPresessionTriggers(): Promise<OrbTrigger[]> {
  const sb = getSupabase();
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const { data: setups, error } = await sb
    .from('pre_session_setups')
    .select('*')
    .eq('trade_date', todayET)
    .eq('status', 'PENDING');

  if (error || !setups?.length) return [];

  const triggered: OrbTrigger[] = [];

  for (const setup of setups) {
    try {
      const quote = await fetchQuote(setup.ticker);
      if (!quote?.price) continue;
      const price = quote.price;

      const priceTriggered =
        setup.signal === 'BUY'  ? price >= setup.trigger_price :
        setup.signal === 'SELL' ? price <= setup.trigger_price : false;

      if (!priceTriggered) continue;

      // Intraday RVOL: project live volume to a full-day equivalent and compare to 10d avg.
      const liveVolume = quote.volume ?? 0;
      const avg10d     = setup.avg_volume_10d ?? 0;
      const etNow      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      // Clamp to at least 1 minute to avoid divide-by-zero at exactly 9:30/9:35
      const minElapsed = Math.max(1, (etNow.getHours() - 9) * 60 + etNow.getMinutes() - 30);
      const projected  = liveVolume * (390 / minElapsed);
      const liveRvol   = avg10d > 0 ? projected / avg10d : null;

      if (liveRvol !== null && liveRvol < MIN_EXEC_RVOL) {
        log(`${setup.ticker}: ORB ${setup.signal} @ $${price.toFixed(2)} — RVOL too low (${liveRvol.toFixed(2)}x, need ${MIN_EXEC_RVOL}x)`);
        continue;
      }

      log(`${setup.ticker}: ORB ${setup.signal} triggered @ $${price.toFixed(2)} | RVOL ${liveRvol?.toFixed(2) ?? 'n/a'}x`);
      triggered.push({
        setupId:     setup.id,
        ticker:      setup.ticker,
        signal:      setup.signal as 'BUY' | 'SELL',
        price,
        stopLoss:    setup.stop_loss,
        takeProfit1: setup.take_profit1,
        takeProfit2: setup.take_profit2 ?? null,
        liveRvol,
        reason:      setup.reason,
      });
    } catch (err) {
      log(`${setup.ticker}: error — ${err}`);
    }
  }

  return triggered;
}

/** Mark a setup's status after the scheduler attempts execution */
export async function markPresessionSetupStatus(
  setupId: string,
  status: 'TRIGGERED' | 'SKIPPED',
  tradeId?: string,
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from('pre_session_setups')
    .update({
      status,
      triggered_at:       new Date().toISOString(),
      triggered_trade_id: tradeId ?? null,
    })
    .eq('id', setupId);
}

/**
 * Expire all PENDING setups from today that were never triggered.
 * Called at 10:30 AM ET when the ORB window closes.
 */
export async function expirePresessionSetups(): Promise<void> {
  const sb = getSupabase();
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { count } = await sb
    .from('pre_session_setups')
    .update({ status: 'EXPIRED' })
    .eq('trade_date', todayET)
    .eq('status', 'PENDING');
  if ((count ?? 0) > 0) log(`Expired ${count} untriggered ORB setups for ${todayET}`);
}
