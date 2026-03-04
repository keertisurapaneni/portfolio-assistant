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
  // Use Intl to correctly determine the UTC offset for America/New_York on the given date.
  // This handles DST transitions precisely (e.g. DST starts second Sunday of March).
  const [hh, mm] = timeEt.split(':').map(Number);
  const localIso = `${date}T${String(hh ?? 0).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')}:00`;
  // Get the UTC offset for America/New_York on this date by parsing a formatted string
  const probe = new Date(`${date}T12:00:00`);
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const utcFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const etH = parseInt(etFormatter.formatToParts(probe).find(p => p.type === 'hour')?.value ?? '12');
  const utcH = parseInt(utcFormatter.formatToParts(probe).find(p => p.type === 'hour')?.value ?? '12');
  const offsetHours = utcH - etH; // e.g. 5 (EST) or 4 (EDT)
  // Apply offset to the requested time
  const resultDate = new Date(`${localIso}Z`);
  resultDate.setUTCHours(resultDate.getUTCHours() + offsetHours);
  return resultDate.toISOString().replace('.000Z', 'Z');
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
    .select('video_id, platform, source_name, source_handle, canonical_url, reel_url, video_heading, strategy_type, trade_date, timeframe, applicable_timeframes, execution_window_et, extracted_signals, setup_type')
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
  const setupType = (video.setup_type as string | null) ?? null;
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

  // Build execute_at / expires_at from execution_window_et.
  // Influencer pre-market setups have different timing needs per setup type:
  //
  //   breakout      — enter when price breaks the pre-market level w/ volume
  //                   9:35 AM start, 10:30 AM expiry (if it doesn't break in 1st hour, the setup failed)
  //
  //   momentum      — buy the directional move in the opening hour
  //                   9:35 AM start, 11:00 AM expiry (full first hour of momentum)
  //
  //   pullback_vwap — wait for a retest of VWAP / support after the initial move
  //                   9:35 AM start, 12:30 PM expiry (VWAP retests often come after the gap+run fades)
  //
  //   range         — support/resistance play, can trigger any time during regular hours
  //                   9:35 AM start, 02:30 PM expiry (range plays work all day until late-day momentum)
  //
  //   default/null  — conservative default: 9:35 AM start, 11:00 AM expiry
  let executeAt: string | null = null;
  let expiresAt: string | null = null;
  if (executionWindow?.start) {
    executeAt = toUtcTimestamp(tradeDate, executionWindow.start);
  }
  if (executionWindow?.end) {
    expiresAt = toUtcTimestamp(tradeDate, executionWindow.end);
  }

  if (primaryMode === 'DAY_TRADE') {
    if (!executeAt) {
      executeAt = toUtcTimestamp(tradeDate, '09:35'); // skip opening 5 min chaos
    }
    if (!expiresAt) {
      // Expiry depends on setup type — tighter for breakout (thesis fails quickly),
      // wider for pullback/range plays that need time to develop
      const expiryBySetup: Record<string, string> = {
        breakout:      '10:30', // didn't break in 1st hour → setup failed
        momentum:      '11:00', // momentum fades after first hour
        pullback_vwap: '12:30', // VWAP retest may come after the gap+run fades
        range:         '14:30', // range plays are valid all day until late-session momentum
      };
      const defaultExpiry = '11:00';
      expiresAt = toUtcTimestamp(tradeDate, expiryBySetup[setupType ?? ''] ?? defaultExpiry);
    }
  } else {
    // Swing/long-term: default expiry is end of trading day
    if (!expiresAt) {
      const month = parseInt(tradeDate.split('-')[1], 10);
      const etOffset = month >= 3 && month <= 11 ? 4 : 5;
      expiresAt = `${tradeDate}T${16 + etOffset}:00:00Z`;
    }
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

  // Delete all existing PENDING signals for this video before re-importing.
  // This ensures a clean replacement when trade_date changes or signals are corrected —
  // avoids duplicates across different execute_on_date values.
  await supabase
    .from('external_strategy_signals')
    .delete()
    .eq('strategy_video_id', videoId)
    .eq('status', 'PENDING');

  const { error: insertErr } = await supabase
    .from('external_strategy_signals')
    .insert(toInsert);

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: insertErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      imported: toInsert.length,
      tickers: toInsert.map(s => `${s.ticker} ${s.signal}`),
      execute_on_date: tradeDate,
      execute_at: executeAt,
      expires_at: expiresAt,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
