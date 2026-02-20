/**
 * Update strategy_video metadata (source, category) by video_id.
 * Use for manual re-assign or category change.
 *
 * POST body: {
 *   video_id: string;
 *   platform?: 'instagram' | 'twitter' | 'youtube';
 *   source_handle?: string;
 *   source_name?: string;
 *   strategy_type?: 'daily_signal' | 'generic_strategy';
 * }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { video_id?: string; platform?: string; source_handle?: string; source_name?: string; strategy_type?: string };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const video_id = (body.video_id ?? '').trim();
  if (!video_id) {
    return new Response(
      JSON.stringify({ error: 'video_id required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const platform = (body.platform ?? 'instagram') as 'instagram' | 'twitter' | 'youtube';
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  const sourceHandle = (body.source_handle ?? '').trim().toLowerCase();
  const sourceName = (body.source_name ?? '').trim();
  if (sourceHandle) updates.source_handle = sourceHandle;
  if (sourceName) updates.source_name = sourceName;

  const strategyType = body.strategy_type;
  if (strategyType === 'daily_signal' || strategyType === 'generic_strategy') {
    updates.strategy_type = strategyType;
  }

  if (Object.keys(updates).length <= 1) {
    return new Response(
      JSON.stringify({ error: 'Provide at least one of: source_handle, source_name, strategy_type' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data, error } = await supabase
    .from('strategy_videos')
    .update(updates)
    .eq('video_id', video_id)
    .eq('platform', platform)
    .select('id, video_id, platform, source_name, strategy_type')
    .maybeSingle();

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!data) {
    return new Response(
      JSON.stringify({ error: 'Video not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ ok: true, strategy_video: data }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
