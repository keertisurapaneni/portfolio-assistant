/**
 * Unified trade performance logging for ALL closed trades.
 * Logging + analytics only — does not modify trading logic.
 */

import { getSupabase } from './supabase.js';
import type { PaperTrade } from './supabase.js';

// ── Regime helper (SPY SMA50/SMA200 + VIX, cached per day) ─────────────────

export interface RegimeSnapshot {
  spy_above_50: boolean;
  spy_above_200: boolean;
  vix_bucket: 'panic' | 'fear' | 'normal' | 'complacent' | 'unknown';
  vix: number | null;
}

const REGIME_CACHE_KEY = 'trade_perf_regime';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day per spec

let _regimeCache: { data: RegimeSnapshot; date: string; ts: number } | null = null;

async function fetchYahooBars(symbol: string): Promise<{ closes: number[] } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    return closes.length >= 200 ? { closes } : null;
  } catch {
    return null;
  }
}

async function fetchVix(): Promise<number | null> {
  const FINNHUB_BASE = 'https://finnhub.io/api/v1';
  const key = process.env.FINNHUB_API_KEY ?? '';
  if (!key) return null;
  try {
    const res = await fetch(`${FINNHUB_BASE}/quote?symbol=VIX&token=${key}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { c?: number };
    return data.c != null && data.c > 0 ? data.c : null;
  } catch {
    return null;
  }
}

function vixToBucket(vix: number | null): RegimeSnapshot['vix_bucket'] {
  if (vix == null) return 'unknown';
  if (vix > 30) return 'panic';
  if (vix >= 25) return 'fear';
  if (vix >= 15) return 'normal';
  if (vix < 15) return 'complacent';
  return 'unknown';
}

/** Fetch SPY vs SMA50/SMA200 and VIX. Cached per calendar day. */
export async function getRegimeSnapshot(): Promise<RegimeSnapshot> {
  const today = new Date().toISOString().slice(0, 10);
  if (_regimeCache && _regimeCache.date === today && Date.now() - _regimeCache.ts < CACHE_TTL_MS) {
    return _regimeCache.data;
  }
  const spyBars = await fetchYahooBars('SPY');
  const vix = await fetchVix();
  let spy_above_50 = false;
  let spy_above_200 = false;
  if (spyBars && spyBars.closes.length >= 200) {
    const price = spyBars.closes[spyBars.closes.length - 1];
    const sma50 = spyBars.closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const sma200 = spyBars.closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    spy_above_50 = price > sma50;
    spy_above_200 = price > sma200;
  }
  const data: RegimeSnapshot = {
    spy_above_50,
    spy_above_200,
    vix_bucket: vixToBucket(vix),
    vix,
  };
  _regimeCache = { data, date: today, ts: Date.now() };
  return data;
}

// ── MAE/MFE (max drawdown / max runup during hold) ────────────────────────

async function fetchBarsForRange(symbol: string, from: Date, to: Date): Promise<number[] | null> {
  try {
    const p1 = Math.floor(from.getTime() / 1000);
    const p2 = Math.floor(to.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    return closes.length > 0 ? closes : null;
  } catch {
    return null;
  }
}

function computeMaeMfe(closes: number[], entryPrice: number, isLong: boolean): {
  maxDrawdownPct: number | null;
  maxRunupPct: number | null;
} {
  if (closes.length === 0 || entryPrice <= 0) return { maxDrawdownPct: null, maxRunupPct: null };
  let peak = closes[0];
  let maxDd = 0;
  let maxRu = 0;
  for (const p of closes) {
    peak = Math.max(peak, p);
    const ddFromPeak = peak > 0 ? ((peak - p) / peak) * 100 : 0;
    const ruFromEntry = ((p - entryPrice) / entryPrice) * 100;
    if (isLong) {
      maxDd = Math.max(maxDd, ddFromPeak);
      maxRu = Math.max(maxRu, ruFromEntry);
    } else {
      maxDd = Math.max(maxDd, ddFromPeak);
      maxRu = Math.max(maxRu, -ruFromEntry);
    }
  }
  return {
    maxDrawdownPct: Math.round(maxDd * 100) / 100,
    maxRunupPct: Math.round(maxRu * 100) / 100,
  };
}

// ── Tag parsing (LONG_TERM) ──────────────────────────────────────────────

function parseTag(trade: PaperTrade): string | null {
  const combined = (trade.notes ?? '') + ' ' + (trade.scanner_reason ?? '');
  if (/Gold Mine/i.test(combined)) return 'Gold Mine';
  if (/Quiet Compounder|Steady Compounder/i.test(combined)) return 'Steady Compounder';
  return null;
}

// ── Main logging function ─────────────────────────────────────────────────

export interface LogContext {
  source: 'app' | 'scheduler';
  trigger: 'EOD_CLOSE' | 'IB_POSITION_GONE' | 'EXPIRED_DAY_ORDER' | 'EXPIRED_SWING_BRACKET';
}

/** Log a closed trade to trade_performance_log. Idempotent. */
export async function logClosedTradePerformance(
  closedTrade: PaperTrade,
  context?: LogContext
): Promise<void> {
  if (!closedTrade.closed_at) return;
  const strategy = closedTrade.mode as 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  if (!['DAY_TRADE', 'SWING_TRADE', 'LONG_TERM'].includes(strategy)) return;
  if ((closedTrade.notes ?? '').startsWith('Dip buy')) return; // skip dip-buy add-ons

  const entryDatetime = closedTrade.filled_at ?? closedTrade.opened_at ?? closedTrade.created_at;
  if (!entryDatetime) return;

  const exitDatetime = closedTrade.closed_at;
  const entryPrice = closedTrade.fill_price ?? closedTrade.entry_price ?? null;
  const exitPrice = closedTrade.close_price ?? null;
  const qty = closedTrade.quantity ?? 0;
  const notionalAtEntry = closedTrade.position_size ?? (entryPrice != null && qty > 0 ? entryPrice * qty : null);
  const realizedPnl = closedTrade.pnl ?? null;
  const realizedReturnPct = closedTrade.pnl_percent ?? null;
  const daysHeld =
    entryDatetime && exitDatetime
      ? (new Date(exitDatetime).getTime() - new Date(entryDatetime).getTime()) / (24 * 60 * 60 * 1000)
      : null;

  const tag = strategy === 'LONG_TERM' ? parseTag(closedTrade) : null;

  let regimeAtEntry: RegimeSnapshot | null = null;
  let regimeAtExit: RegimeSnapshot | null = null;
  try {
    const regime = await getRegimeSnapshot();
    regimeAtEntry = regime;
    regimeAtExit = regime; // use current regime for both if historical not feasible
  } catch {
    // fail silently
  }

  let maxRunupPct: number | null = null;
  let maxDrawdownPct: number | null = null;
  if (entryPrice != null && entryPrice > 0 && strategy !== 'DAY_TRADE') {
    try {
      const from = new Date(entryDatetime);
      const to = new Date(exitDatetime);
      const bars = await fetchBarsForRange(closedTrade.ticker, from, to);
      if (bars && bars.length > 0) {
        const isLong = closedTrade.signal === 'BUY';
        const { maxDrawdownPct: dd, maxRunupPct: ru } = computeMaeMfe(bars, entryPrice, isLong);
        maxDrawdownPct = dd;
        maxRunupPct = ru;
      }
    } catch {
      // fail silently
    }
  }

  const row = {
    trade_id: closedTrade.id,
    ticker: closedTrade.ticker,
    strategy,
    tag,
    entry_trigger_type: closedTrade.entry_trigger_type ?? null,
    status: 'CLOSED',
    close_reason: closedTrade.close_reason ?? null,
    entry_datetime: entryDatetime,
    exit_datetime: exitDatetime,
    entry_price: entryPrice,
    exit_price: exitPrice,
    qty,
    notional_at_entry: notionalAtEntry,
    realized_pnl: realizedPnl,
    realized_return_pct: realizedReturnPct,
    days_held: daysHeld != null ? Math.round(daysHeld * 100) / 100 : null,
    max_runup_pct_during_hold: maxRunupPct,
    max_drawdown_pct_during_hold: maxDrawdownPct,
    regime_at_entry: regimeAtEntry
      ? { spy_above_50: regimeAtEntry.spy_above_50, spy_above_200: regimeAtEntry.spy_above_200, vix_bucket: regimeAtEntry.vix_bucket }
      : null,
    regime_at_exit: regimeAtExit
      ? { spy_above_50: regimeAtExit.spy_above_50, spy_above_200: regimeAtExit.spy_above_200, vix_bucket: regimeAtExit.vix_bucket }
      : null,
    trigger_label: context?.trigger ?? 'IB_POSITION_GONE',
  };

  const sb = getSupabase();
  const { error } = await sb.from('trade_performance_log').insert(row);
  if (error && error.code !== '23505') throw error; // 23505 = unique violation, idempotent
}
