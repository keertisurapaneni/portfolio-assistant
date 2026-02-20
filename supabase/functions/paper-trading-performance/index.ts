// Paper Trading Performance — rolling attribution from paper_trades (source of truth).
// Uses trade_performance_log for regime data when available.
// GET ?window=7d|30d|90d — returns aggregated metrics for deployed website (no localhost).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PaperTradeRow {
  id: string;
  ticker: string;
  mode: string;
  notes: string | null;
  fill_price: number | null;
  close_price: number | null;
  quantity: number | null;
  position_size: number | null;
  pnl: number | null;
  pnl_percent: number | null;
  filled_at: string | null;
  closed_at: string | null;
  opened_at: string;
  created_at: string;
  close_reason: string | null;
}

interface LogRow {
  trade_id: string;
  regime_at_entry: { spy_above_50?: boolean; spy_above_200?: boolean; vix_bucket?: string } | null;
  regime_at_exit: { spy_above_50?: boolean; spy_above_200?: boolean; vix_bucket?: string } | null;
  tag: string | null;
}

interface TradePerformanceRow {
  trade_id: string;
  ticker: string;
  strategy: string;
  tag: string | null;
  entry_datetime: string;
  exit_datetime: string;
  entry_price: number | null;
  exit_price: number | null;
  qty: number | null;
  notional_at_entry: number | null;
  realized_pnl: number | null;
  realized_return_pct: number | null;
  days_held: number | null;
  close_reason: string | null;
  regime_at_entry: { spy_above_50?: boolean; spy_above_200?: boolean; vix_bucket?: string } | null;
  regime_at_exit: { spy_above_50?: boolean; spy_above_200?: boolean; vix_bucket?: string } | null;
}

function regimeBucket(row: TradePerformanceRow): string {
  const r = row.regime_at_entry ?? row.regime_at_exit;
  if (!r) return 'unknown';
  const above200 = r.spy_above_200 ? 'above200' : 'below200';
  const vix = r.vix_bucket ?? 'unknown';
  return `${above200}_${vix}`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

interface GroupMetrics {
  count_trades_closed: number;
  win_rate: number;
  avg_return_pct: number;
  median_return_pct: number;
  stdev_return_pct: number;
  profit_factor: number;
  avg_days_held: number;
  total_pnl: number;
}

function computeGroupMetrics(rows: TradePerformanceRow[]): GroupMetrics {
  const returns = rows.map(r => r.realized_return_pct).filter((x): x is number => x != null);
  const pnls = rows.map(r => r.realized_pnl).filter((x): x is number => x != null);
  const daysHeld = rows.map(r => r.days_held).filter((x): x is number => x != null);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const sumWins = wins.reduce((a, b) => a + b, 0);
  const sumLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);
  return {
    count_trades_closed: rows.length,
    win_rate: rows.length > 0 ? wins.length / rows.length : 0,
    avg_return_pct: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
    median_return_pct: median(returns),
    stdev_return_pct: stdev(returns),
    profit_factor: profitFactor === Infinity ? 999 : Math.round(profitFactor * 100) / 100,
    avg_days_held: daysHeld.length > 0 ? daysHeld.reduce((a, b) => a + b, 0) / daysHeld.length : 0,
    total_pnl: pnls.reduce((a, b) => a + b, 0),
  };
}

function aggregateByGroup(
  rows: TradePerformanceRow[],
  groupKey: (r: TradePerformanceRow) => string
): Record<string, GroupMetrics> {
  const byKey = new Map<string, TradePerformanceRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const out: Record<string, GroupMetrics> = {};
  for (const [k, arr] of byKey) {
    out[k] = computeGroupMetrics(arr);
  }
  return out;
}

function portfolioRealizedReturnPct(rows: TradePerformanceRow[]): number {
  const totalNotional = rows.reduce((s, r) => s + (r.notional_at_entry ?? 0), 0);
  const totalPnl = rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
  return totalNotional > 0 ? (totalPnl / totalNotional) * 100 : 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window') || '30d';
  const validWindow = ['7d', '30d', '90d'].includes(windowParam) ? windowParam : '30d';
  const days = validWindow === '7d' ? 7 : validWindow === '30d' ? 30 : 90;

  const asOf = new Date();
  const asOfStr = asOf.toISOString();
  const from = new Date(asOf);
  from.setDate(from.getDate() - days);

  const emptyOverall = {
    count_trades_closed: 0,
    win_rate: 0,
    avg_return_pct: 0,
    median_return_pct: 0,
    stdev_return_pct: 0,
    profit_factor: 0,
    avg_days_held: 0,
    total_pnl: 0,
    portfolio_realized_return_pct: 0,
  };

  const warnings: string[] = [];

  try {
    // Use paper_trades as source of truth (matches category cards)
    const { data: tradesData, error: tradesError } = await supabase
      .from('paper_trades')
      .select('id, ticker, mode, notes, fill_price, close_price, quantity, position_size, pnl, pnl_percent, filled_at, closed_at, opened_at, created_at, close_reason')
      .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED'])
      .not('fill_price', 'is', null)
      .not('closed_at', 'is', null)
      .gte('closed_at', from.toISOString())
      .lte('closed_at', asOfStr)
      .order('closed_at', { ascending: false })
      .limit(500);

    if (tradesError) {
      throw tradesError;
    }

    const trades = (tradesData ?? []) as PaperTradeRow[];

    // Exclude dip-buy add-ons (same as trade_performance_log)
    const filteredTrades = trades.filter(t => !(t.notes ?? '').startsWith('Dip buy'));

    // Only include DAY_TRADE, SWING_TRADE, LONG_TERM (same as log)
    const validTrades = filteredTrades.filter(t =>
      ['DAY_TRADE', 'SWING_TRADE', 'LONG_TERM'].includes(t.mode)
    );

    if (validTrades.length === 0) {
      warnings.push(`No closed trades in the last ${days} days.`);
      return new Response(
        JSON.stringify({
          asOf: asOfStr,
          overall: emptyOverall,
          byStrategy: {},
          byTag: {},
          byRegime: {},
          recentClosedTrades: [],
          warnings,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch regime from trade_performance_log for those trades (optional enrichment)
    const tradeIds = validTrades.map(t => t.id);
    const { data: logData } = await supabase
      .from('trade_performance_log')
      .select('trade_id, regime_at_entry, regime_at_exit, tag')
      .in('trade_id', tradeIds);

    const logByTradeId = new Map<string, LogRow>();
    for (const r of (logData ?? []) as LogRow[]) {
      logByTradeId.set(r.trade_id, r);
    }

    const rows: TradePerformanceRow[] = validTrades.map(t => {
      const entryDatetime = t.filled_at ?? t.opened_at ?? t.created_at;
      const exitDatetime = t.closed_at!;
      const entryPrice = t.fill_price ?? null;
      const exitPrice = t.close_price ?? null;
      const qty = t.quantity ?? 0;
      const notional = t.position_size ?? (entryPrice != null && qty > 0 ? entryPrice * qty : null);
      const daysHeld = entryDatetime && exitDatetime
        ? (new Date(exitDatetime).getTime() - new Date(entryDatetime).getTime()) / (24 * 60 * 60 * 1000)
        : null;

      const log = logByTradeId.get(t.id);
      const tag = t.mode === 'LONG_TERM' ? (log?.tag ?? null) : null;

      return {
        trade_id: t.id,
        ticker: t.ticker,
        strategy: t.mode,
        tag,
        entry_datetime: entryDatetime,
        exit_datetime: exitDatetime,
        entry_price: entryPrice,
        exit_price: exitPrice,
        qty,
        notional_at_entry: notional,
        realized_pnl: t.pnl ?? null,
        realized_return_pct: t.pnl_percent ?? null,
        days_held: daysHeld != null ? Math.round(daysHeld * 100) / 100 : null,
        close_reason: t.close_reason ?? null,
        regime_at_entry: log?.regime_at_entry ?? null,
        regime_at_exit: log?.regime_at_exit ?? null,
      };
    });
    const overall = computeGroupMetrics(rows);
    const portfolioReturn = portfolioRealizedReturnPct(rows);
    const byStrategy = aggregateByGroup(rows, r => r.strategy);
    const byTag = aggregateByGroup(rows.filter(r => r.tag), r => r.tag!);
    const byRegime = aggregateByGroup(rows, regimeBucket);

    const MIN_TRADES = 10;
    for (const [k, m] of Object.entries(byStrategy)) {
      if (m.count_trades_closed < MIN_TRADES) warnings.push(`Insufficient sample size: ${k} has ${m.count_trades_closed} trades (<${MIN_TRADES})`);
    }
    for (const [k, m] of Object.entries(byTag)) {
      if (m.count_trades_closed < MIN_TRADES) warnings.push(`Insufficient sample size: ${k} has ${m.count_trades_closed} trades (<${MIN_TRADES})`);
    }

    const payload = {
      asOf: asOfStr,
      overall: { ...overall, portfolio_realized_return_pct: portfolioReturn },
      byStrategy,
      byTag,
      byRegime,
      recentClosedTrades: rows.slice(0, 50),
      warnings,
    };

    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[paper-trading-performance]:', err);
    warnings.push(err instanceof Error ? err.message : 'Failed to load performance data');
    return new Response(
      JSON.stringify({
        asOf: asOfStr,
        overall: emptyOverall,
        byStrategy: {},
        byTag: {},
        byRegime: {},
        recentClosedTrades: [],
        warnings,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
