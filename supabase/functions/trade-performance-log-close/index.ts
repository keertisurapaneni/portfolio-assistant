// POST — log closed trade to trade_performance_log. Replaces localhost:3001/api/trade-performance-log/close.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TRIGGERS = ['EOD_CLOSE', 'IB_POSITION_GONE', 'EXPIRED_DAY_ORDER', 'EXPIRED_SWING_BRACKET'] as const;

function parseTag(notes: string | null, scannerReason: string | null): string | null {
  const combined = (notes ?? '') + ' ' + (scannerReason ?? '');
  if (/Gold Mine/i.test(combined)) return 'Gold Mine';
  if (/Quiet Compounder|Steady Compounder/i.test(combined)) return 'Steady Compounder';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const tradeId = body?.tradeId ?? body?.trade_id;
    const trigger = TRIGGERS.includes(body?.trigger) ? body.trigger : 'IB_POSITION_GONE';

    if (!tradeId || typeof tradeId !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing tradeId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: trade, error: fetchErr } = await supabase
      .from('paper_trades')
      .select('id, ticker, mode, signal, notes, scanner_reason, fill_price, entry_price, close_price, quantity, position_size, pnl, pnl_percent, filled_at, opened_at, created_at, closed_at, close_reason, entry_trigger_type')
      .eq('id', tradeId)
      .single();

    if (fetchErr || !trade) {
      return new Response(
        JSON.stringify({ error: 'Trade not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!trade.closed_at) {
      return new Response(
        JSON.stringify({ error: 'Trade not closed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const strategy = trade.mode as string;
    if (!['DAY_TRADE', 'SWING_TRADE', 'LONG_TERM'].includes(strategy)) {
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if ((trade.notes ?? '').startsWith('Dip buy')) {
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const entryDatetime = trade.filled_at ?? trade.opened_at ?? trade.created_at;
    if (!entryDatetime) {
      return new Response(JSON.stringify({ error: 'Missing entry datetime' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const entryPrice = trade.fill_price ?? trade.entry_price ?? null;
    const exitPrice = trade.close_price ?? null;
    const qty = trade.quantity ?? 0;
    const notionalAtEntry = trade.position_size ?? (entryPrice != null && qty > 0 ? entryPrice * qty : null);
    const daysHeld =
      (new Date(trade.closed_at).getTime() - new Date(entryDatetime).getTime()) / (24 * 60 * 60 * 1000);
    const tag = strategy === 'LONG_TERM' ? parseTag(trade.notes, trade.scanner_reason) : null;

    const row = {
      trade_id: trade.id,
      ticker: trade.ticker,
      strategy,
      tag,
      entry_trigger_type: trade.entry_trigger_type ?? null,
      status: 'CLOSED',
      close_reason: trade.close_reason ?? null,
      entry_datetime: entryDatetime,
      exit_datetime: trade.closed_at,
      entry_price: entryPrice,
      exit_price: exitPrice,
      qty,
      notional_at_entry: notionalAtEntry,
      realized_pnl: trade.pnl ?? null,
      realized_return_pct: trade.pnl_percent ?? null,
      days_held: Math.round(daysHeld * 100) / 100,
      max_runup_pct_during_hold: null,
      max_drawdown_pct_during_hold: null,
      regime_at_entry: null,
      regime_at_exit: null,
      trigger_label: trigger,
    };

    const { error: insertErr } = await supabase.from('trade_performance_log').insert(row);
    if (insertErr && insertErr.code !== '23505') {
      console.error('[trade-performance-log-close]:', insertErr);
      return new Response(
        JSON.stringify({ error: insertErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[trade-performance-log-close]:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
