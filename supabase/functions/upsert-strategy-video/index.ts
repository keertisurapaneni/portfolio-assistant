/**
 * Upsert a strategy video into strategy_videos table.
 * Called by ingest script after transcribing and extracting metadata.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface UpsertPayload {
  video_id: string;
  platform?: 'instagram' | 'twitter' | 'youtube';
  source_handle?: string;
  source_name: string;
  reel_url?: string;
  canonical_url?: string;
  video_heading?: string;
  strategy_type?: 'daily_signal' | 'generic_strategy';
  timeframe?: string;
  applicable_timeframes?: string[];
  execution_window_et?: { start?: string; end?: string };
  trade_date?: string;
  extracted_signals?: unknown[];
  exempt_from_auto_deactivation?: boolean;
  status?: string;
  summary?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let body: UpsertPayload;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const video_id = body.video_id?.trim();
  const source_name = body.source_name?.trim();
  if (!video_id || !source_name) {
    return new Response(JSON.stringify({ error: 'video_id and source_name required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const platform = body.platform ?? 'instagram';
  const row = {
    video_id,
    platform,
    source_handle: body.source_handle ?? null,
    source_name,
    reel_url: body.reel_url ?? null,
    canonical_url: body.canonical_url ?? null,
    video_heading: body.video_heading ?? null,
    strategy_type: body.strategy_type ?? null,
    timeframe: body.timeframe ?? null,
    applicable_timeframes: body.applicable_timeframes ?? [],
    execution_window_et: body.execution_window_et ?? null,
    trade_date: body.trade_date ?? null,
    extracted_signals: body.extracted_signals ?? null,
    exempt_from_auto_deactivation: body.exempt_from_auto_deactivation ?? false,
    status: body.status ?? 'tracked',
    summary: body.summary ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('strategy_videos')
    .upsert(row, { onConflict: 'platform,video_id', ignoreDuplicates: false })
    .select('id, video_id, platform, source_name')
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, strategy_video: data }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
