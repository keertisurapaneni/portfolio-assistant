/**
 * Import extracted signals from a daily_signal strategy_video into external_strategy_signals.
 * Called automatically after extraction completes. No manual approval needed — paper trading only.
 *
 * POST body: { video_id: string; platform?: string }
 *
 * Flow:
 * 1. Load strategy_video (must be daily_signal, ingest_status=done, extracted_signals populated)
 * 2. For each extracted signal: create PENDING external_strategy_signals rows
 *    - longTriggerAbove  → BUY signal
 *    - shortTriggerBelow → SELL signal
 * 3. If execution_window_et present: set execute_at / expires_at (ET timezone)
 * 4. Skip if signal already exists for same video_id + ticker + signal direction (idempotent)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface ExtractedSignal {
  ticker?: string;
  longTriggerAbove?: number | null;
  longTargets?: number[];
  shortTriggerBelow?: number | null;
  shortTargets?: number[];
  stopLoss?: number | null;
  notes?: string | null;
}

interface ExecutionWindow {
  start?: string; // "HH:MM" ET
  end?: string;
}

/** Convert "HH:MM" ET string on a given YYYY-MM-DD into a UTC ISO timestamp */
function toUtcTimestamp(date: string, timeEt: string): string {
  // ET is UTC-5 (EST) or UTC-4 (EDT). Use -5 as conservative (market hours are EST/EDT).
  // Proper approach: treat as America/New_York. Approximate with -5 offset.
  const [hh, mm] = timeEt.split(':').map(Number);
  // ET offset: -4 during daylight saving (Mar-Nov), -5 otherwise
  // Rough DST detection: month between March and November
  const month = parseInt(date.split('-')[1], 10);
  const etOffsetHours = month >= 3 && month <= 11 ? 4 : 5;
  const utcH = (hh ?? 0) + etOffsetHours;
  const paddedH = String(utcH).padStart(2, '0');
  const paddedM = String(mm ?? 0).padStart(2, '0');
  return `${date}T${paddedH}:${paddedM}:00Z`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { video_id?: string; platform?: string };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const videoId = (body.video_id ?? '').trim();
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'video_id required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Load the strategy_video
  const { data: video, error: fetchErr } = await supabase
    .from('strategy_videos')
    .select('video_id, platform, source_name, source_handle, canonical_url, reel_url, video_heading, strategy_type, trade_date, timeframe, applicable_timeframes, execution_window_et, extracted_signals')
    .eq('video_id', videoId)
    .eq('status', 'tracked')
    .maybeSingle();

  if (fetchErr || !video) {
    return new Response(JSON.stringify({ error: fetchErr?.message ?? 'Video not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (video.strategy_type !== 'daily_signal') {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'Not a daily_signal — no signals to import' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const signals = (Array.isArray(video.extracted_signals) ? video.extracted_signals : []) as ExtractedSignal[];
  if (signals.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'No extracted_signals in video' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!video.trade_date) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'No trade_date on video — cannot schedule signals' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Don't create signals for weekends — market is closed
  const tradeDay = new Date(`${video.trade_date}T12:00:00Z`).getDay(); // 0=Sun, 6=Sat
  if (tradeDay === 0 || tradeDay === 6) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: `trade_date ${video.trade_date} falls on a weekend — market closed` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const tradeDate = video.trade_date as string;
  const executionWindow = video.execution_window_et as ExecutionWindow | null;
  const sourceHandle = (video.source_handle ?? '').trim().toLowerCase();
  const sourceUrl = sourceHandle
    ? `https://www.instagram.com/${sourceHandle}/`
    : ((video.canonical_url ?? video.reel_url ?? null) as string | null);

  // Determine mode from timeframe / applicable_timeframes
  const applicableTimeframes = Array.isArray(video.applicable_timeframes) ? video.applicable_timeframes : [];
  const timeframe = (video.timeframe as string | null) ?? null;
  const primaryMode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM' =
    applicableTimeframes.includes('DAY_TRADE') || timeframe === 'DAY_TRADE'
      ? 'DAY_TRADE'
      : applicableTimeframes.includes('SWING_TRADE') || timeframe === 'SWING_TRADE'
      ? 'SWING_TRADE'
      : 'DAY_TRADE'; // default to day trade for daily signals

  // Build execute_at / expires_at from execution_window_et
  let executeAt: string | null = null;
  let expiresAt: string | null = null;
  if (executionWindow?.start) {
    executeAt = toUtcTimestamp(tradeDate, executionWindow.start);
  }
  if (executionWindow?.end) {
    expiresAt = toUtcTimestamp(tradeDate, executionWindow.end);
  }
  // Default expiry: end of trading day (16:00 ET = 21:00 UTC)
  if (!expiresAt) {
    const month = parseInt(tradeDate.split('-')[1], 10);
    const etOffset = month >= 3 && month <= 11 ? 4 : 5;
    expiresAt = `${tradeDate}T${16 + etOffset}:00:00Z`;
  }

  const toInsert: Record<string, unknown>[] = [];

  for (const sig of signals) {
    const ticker = (sig.ticker ?? '').trim().toUpperCase();
    if (!ticker) continue;

    const stopLoss = sig.stopLoss ?? null;
    const noteText = sig.notes ?? null;

    // Long (BUY) signal
    if (sig.longTriggerAbove != null) {
      const entryPrice = sig.longTriggerAbove;
      const targetPrice = sig.longTargets?.[0] ?? null;
      toInsert.push({
        source_name: video.source_name,
        source_url: sourceUrl,
        ticker,
        signal: 'BUY',
        mode: primaryMode,
        confidence: 7,
        entry_price: entryPrice,
        stop_loss: stopLoss,
        target_price: targetPrice,
        execute_on_date: tradeDate,
        execute_at: executeAt,
        expires_at: expiresAt,
        notes: noteText ?? `Long above ${entryPrice}${stopLoss ? `, stop ${stopLoss}` : ''}${targetPrice ? `, target ${targetPrice}` : ''}`,
        status: 'PENDING',
        strategy_video_id: videoId,
        strategy_video_heading: video.video_heading ?? null,
      });
    }

    // Short (SELL) signal
    if (sig.shortTriggerBelow != null) {
      const entryPrice = sig.shortTriggerBelow;
      const targetPrice = sig.shortTargets?.[0] ?? null;
      toInsert.push({
        source_name: video.source_name,
        source_url: sourceUrl,
        ticker,
        signal: 'SELL',
        mode: primaryMode,
        confidence: 7,
        entry_price: entryPrice,
        stop_loss: stopLoss,
        target_price: targetPrice,
        execute_on_date: tradeDate,
        execute_at: executeAt,
        expires_at: expiresAt,
        notes: noteText ?? `Short below ${entryPrice}${stopLoss ? `, stop ${stopLoss}` : ''}${targetPrice ? `, target ${targetPrice}` : ''}`,
        status: 'PENDING',
        strategy_video_id: videoId,
        strategy_video_heading: video.video_heading ?? null,
      });
    }
  }

  if (toInsert.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, imported: 0, reason: 'No long/short triggers found in extracted_signals' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Check for existing signals for this video to avoid duplicates
  const { data: existing } = await supabase
    .from('external_strategy_signals')
    .select('ticker, signal')
    .eq('strategy_video_id', videoId)
    .eq('execute_on_date', tradeDate);

  const existingKeys = new Set((existing ?? []).map((r: { ticker: string; signal: string }) => `${r.ticker}::${r.signal}`));
  const newSignals = toInsert.filter(r => !existingKeys.has(`${r.ticker}::${r.signal}`));

  if (newSignals.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, imported: 0, reason: 'All signals already exist for this video + date' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { error: insertErr } = await supabase
    .from('external_strategy_signals')
    .insert(newSignals);

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: insertErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      imported: newSignals.length,
      tickers: newSignals.map(s => `${s.ticker} ${s.signal}`),
      execute_on_date: tradeDate,
      execute_at: executeAt,
      expires_at: expiresAt,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
