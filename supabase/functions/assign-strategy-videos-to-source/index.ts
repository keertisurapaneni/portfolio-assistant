/**
 * Manually assign strategy_videos with source_name = 'Unknown' to a known source.
 * Use when auto-fix fails (e.g. Instagram blocks server-side fetch).
 *
 * POST body: { source_handle: string, source_name: string, video_ids?: string[], strategy_type?: 'daily_signal' | 'generic_strategy' }
 * - If video_ids provided: only assign those videos (by video_id)
 * - If omitted: assign all Unknown videos to the given source
 * - strategy_type: optional, also update category
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { source_handle?: string; source_name?: string; video_ids?: string[]; strategy_type?: string };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const sourceHandle = (body.source_handle ?? '').trim().toLowerCase();
  const sourceName = (body.source_name ?? '').trim();
  const videoIds = Array.isArray(body.video_ids)
    ? body.video_ids.map((id) => String(id).trim()).filter(Boolean)
    : undefined;

  if (!sourceHandle || !sourceName) {
    return new Response(
      JSON.stringify({ error: 'source_handle and source_name are required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  let query = supabase
    .from('strategy_videos')
    .select('id, video_id')
    .eq('status', 'tracked')
    .eq('source_name', 'Unknown');

  if (videoIds && videoIds.length > 0) {
    query = query.in('video_id', videoIds);
  }

  const { data: unknowns, error: fetchErr } = await query.limit(50);

  if (fetchErr) {
    return new Response(
      JSON.stringify({ error: fetchErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!unknowns?.length) {
    return new Response(
      JSON.stringify({ ok: true, assigned: 0, message: 'No Unknown videos to assign' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const ids = unknowns.map((r) => r.id);
  const updatePayload: Record<string, unknown> = {
    source_handle: sourceHandle,
    source_name: sourceName,
    updated_at: new Date().toISOString(),
  };
  if (body.strategy_type === 'daily_signal' || body.strategy_type === 'generic_strategy') {
    updatePayload.strategy_type = body.strategy_type;
  }
  const { error: updateErr } = await supabase
    .from('strategy_videos')
    .update(updatePayload)
    .in('id', ids);

  if (updateErr) {
    return new Response(
      JSON.stringify({ error: updateErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      assigned: ids.length,
      video_ids: unknowns.map((r) => r.video_id),
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
