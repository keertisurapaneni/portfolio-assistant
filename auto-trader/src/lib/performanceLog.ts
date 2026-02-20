/**
 * Structured performance logging for closed LONG_TERM trades.
 * Logging only — does not modify trading logic.
 */

import { getSupabase } from './supabase.js';
import type { PaperTrade } from './supabase.js';

// ── Yahoo historical data (date range) ────────────────────

async function fetchYahooDailyBarsForRange(
  symbol: string,
  fromDate: Date,
  toDate: Date
): Promise<{ dates: string[]; closes: number[] } | null> {
  try {
    const period1 = Math.floor(fromDate.getTime() / 1000);
    const period2 = Math.floor(toDate.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    const timestamps = (result.timestamp ?? []) as number[];
    const dates = timestamps.map((ts: number) => new Date(ts * 1000).toISOString().slice(0, 10));
    if (closes.length === 0 || dates.length === 0) return null;
    return { dates, closes };
  } catch {
    return null;
  }
}

/** SPY vs SMA200 at a given date — returns 'above_sma200' | 'below_sma200' */
async function getSpyRegimeAtDate(date: Date): Promise<string | null> {
  const from = new Date(date);
  from.setDate(from.getDate() - 250); // need 200+ days before
  const bars = await fetchYahooDailyBarsForRange('SPY', from, date);
  if (!bars || bars.closes.length < 200) return null;
  const price = bars.closes[bars.closes.length - 1];
  const sma200 = bars.closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
  return price >= sma200 ? 'above_sma200' : 'below_sma200';
}

/** Max drawdown % (peak-to-trough) and max runup % (from entry) during hold */
function computeDrawdownRunup(
  closes: number[],
  entryPrice: number,
  isLong: boolean
): { maxDrawdown: number | null; maxRunup: number | null } {
  if (closes.length === 0 || entryPrice <= 0) return { maxDrawdown: null, maxRunup: null };
  let peak = closes[0];
  let maxDrawdown = 0;
  let maxRunup = 0;
  for (const p of closes) {
    peak = Math.max(peak, p);
    const ddFromPeak = peak > 0 ? ((peak - p) / peak) * 100 : 0;
    const runupFromEntry = ((p - entryPrice) / entryPrice) * 100;
    if (isLong) {
      maxDrawdown = Math.max(maxDrawdown, ddFromPeak);
      maxRunup = Math.max(maxRunup, runupFromEntry);
    } else {
      maxDrawdown = Math.max(maxDrawdown, ddFromPeak);
      maxRunup = Math.max(maxRunup, -runupFromEntry); // short: profit when price drops
    }
  }
  return {
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxRunup: Math.round(maxRunup * 100) / 100,
  };
}

/** Parse tag, conviction, valuationTag from LONG_TERM trade notes/scanner_reason */
function parseLongTermMeta(trade: PaperTrade): {
  tag: string | null;
  conviction: number | null;
  valuationTag: string | null;
} {
  const notes = trade.notes ?? '';
  const scannerReason = trade.scanner_reason ?? '';
  const combined = notes + ' ' + scannerReason;

  const isGoldMine = /Gold Mine/i.test(combined);
  const isCompounder = /Quiet Compounder|Steady Compounder/i.test(combined);
  const tag = isGoldMine ? 'Gold Mine' : isCompounder ? 'Steady Compounder' : null;

  const conviction = trade.scanner_confidence ?? null;

  const valMatch = combined.match(/(?:Deep Value|Undervalued|Fair Value|Fully Valued)/i);
  const valuationTag = valMatch ? valMatch[0] : null;

  return { tag, conviction, valuationTag };
}

export interface PerformanceLogEntry {
  paper_trade_id: string;
  ticker: string;
  tag: string | null;
  conviction: number | null;
  valuation_tag: string | null;
  entry_date: string;
  exit_date: string;
  entry_regime: string | null;
  position_size: number | null;
  return_pct: number | null;
  max_drawdown_during_hold: number | null;
  max_runup_during_hold: number | null;
  days_held: number | null;
}

/** Log a closed LONG_TERM trade to performance_log. Fetches entryRegime, maxDrawdown, maxRunup. */
export async function logLongTermPerformance(trade: PaperTrade): Promise<void> {
  if (trade.mode !== 'LONG_TERM') return;
  if ((trade.notes ?? '').startsWith('Dip buy')) return; // skip dip-buy add-ons
  if (!trade.closed_at || !trade.filled_at) return;

  const entryDate = new Date(trade.filled_at);
  const exitDate = new Date(trade.closed_at);
  const { tag, conviction, valuationTag } = parseLongTermMeta(trade);
  const positionSize = trade.position_size ?? null;
  const returnPct = trade.pnl_percent ?? null;
  const daysHeld = (exitDate.getTime() - entryDate.getTime()) / (24 * 60 * 60 * 1000);

  let entryRegime: string | null = null;
  let maxDrawdown: number | null = null;
  let maxRunup: number | null = null;

  try {
    entryRegime = await getSpyRegimeAtDate(entryDate);
  } catch {
    // fail silently
  }

  try {
    const bars = await fetchYahooDailyBarsForRange(trade.ticker, entryDate, exitDate);
    if (bars && bars.closes.length > 0) {
      const entryPrice = trade.fill_price ?? trade.entry_price ?? bars.closes[0];
      const isLong = trade.signal === 'BUY';
      const { maxDrawdown: dd, maxRunup: ru } = computeDrawdownRunup(bars.closes, entryPrice, isLong);
      maxDrawdown = dd;
      maxRunup = ru;
    }
  } catch {
    // fail silently
  }

  const sb = getSupabase();
  const { error } = await sb.from('performance_log').insert({
    paper_trade_id: trade.id,
    ticker: trade.ticker,
    tag,
    conviction,
    valuation_tag: valuationTag,
    entry_date: trade.filled_at,
    exit_date: trade.closed_at,
    entry_regime: entryRegime,
    position_size: positionSize,
    return_pct: returnPct,
    max_drawdown_during_hold: maxDrawdown,
    max_runup_during_hold: maxRunup,
    days_held: Math.round(daysHeld * 100) / 100,
  });
  // Ignore duplicate (23505) — already logged by scheduler or app
  if (error && error.code !== '23505') throw error;
}
