/**
 * Manually assign strategy_videos with source_name = 'Unknown' to a known source.
 * Use when auto-fix fails (e.g. Instagram blocks server-side fetch).
 *
 * POST body: { source_handle: string, source_name: string, video_ids?: string[], strategy_type?: 'daily_signal' | 'generic_strategy', cleanup?: boolean }
 * - If video_ids provided: only assign those videos (by video_id)
 * - If omitted: assign all Unknown videos to the given source
 * - strategy_type: optional, also update category
 * - cleanup: if true, sync external_strategy_signals and paper_trades for already-assigned videos
 *   (fixes duplicates showing in both Unknown and the correct source)
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

  let body: { source_handle?: string; source_name?: string; video_ids?: string[]; strategy_type?: string; cleanup?: boolean };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Cleanup mode:
  // 1. For already-assigned videos: sync any signals/trades still saying 'Unknown'
  // 2. For Unknown videos: auto-assign if their signals have a consistent known source
  if (body.cleanup === true) {
    let autoAssigned = 0;

    // Step A: auto-assign Unknown videos by inferring source from their signals
    const { data: unknownVideos } = await supabase
      .from('strategy_videos')
      .select('id, video_id, source_name')
      .eq('status', 'tracked')
      .eq('source_name', 'Unknown')
      .not('video_id', 'is', null)
      .limit(100);

    for (const vid of unknownVideos ?? []) {
      const vidId = (vid.video_id ?? '').trim();
      if (!vidId) continue;

      // Check signals for a consistent non-Unknown source
      const { data: sigs } = await supabase
        .from('external_strategy_signals')
        .select('source_name, source_url')
        .eq('strategy_video_id', vidId)
        .neq('source_name', 'Unknown')
        .not('source_name', 'is', null)
        .limit(10);

      if (!sigs?.length) continue;

      // Use the most common non-Unknown source_name from signals
      const tally: Record<string, { count: number; url: string | null }> = {};
      for (const s of sigs) {
        const n = (s.source_name ?? '').trim();
        if (!n || n === 'Unknown') continue;
        tally[n] = { count: (tally[n]?.count ?? 0) + 1, url: s.source_url ?? tally[n]?.url ?? null };
      }
      const entries = Object.entries(tally).sort((a, b) => b[1].count - a[1].count);
      if (!entries.length) continue;

      const [inferredSource, { url: inferredUrl }] = entries[0];
      // Infer source_handle from URL if possible
      const handleMatch = (inferredUrl ?? '').match(/instagram\.com\/([^/]+)/);
      const inferredHandle = handleMatch?.[1]?.toLowerCase() ?? null;

      await supabase
        .from('strategy_videos')
        .update({
          source_name: inferredSource,
          ...(inferredHandle ? { source_handle: inferredHandle } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', vid.id);

      autoAssigned++;
    }

    // Step B: for already-assigned videos, fix any signals/trades still marked Unknown
    const { data: assigned } = await supabase
      .from('strategy_videos')
      .select('video_id, source_name, source_handle')
      .eq('status', 'tracked')
      .neq('source_name', 'Unknown')
      .not('video_id', 'is', null)
      .limit(200);

    for (const row of assigned ?? []) {
      const vidId = (row.video_id ?? '').trim();
      const sourceName = (row.source_name ?? '').trim();
      const handle = (row.source_handle ?? '').trim().toLowerCase();
      if (!vidId || !sourceName) continue;
      const sourceUrl = handle ? `https://www.instagram.com/${handle}/` : null;
      await supabase
        .from('external_strategy_signals')
        .update({ source_name: sourceName, source_url: sourceUrl, updated_at: new Date().toISOString() })
        .eq('strategy_video_id', vidId)
        .eq('source_name', 'Unknown');
      await supabase
        .from('paper_trades')
        .update({ strategy_source: sourceName, strategy_source_url: sourceUrl })
        .eq('strategy_video_id', vidId)
        .eq('strategy_source', 'Unknown');
    }

    return new Response(
      JSON.stringify({ ok: true, cleanup: true, autoAssigned, synced: (assigned ?? []).length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
  const vidIds = unknowns.map((r) => r.video_id).filter(Boolean) as string[];
  const sourceUrl = `https://www.instagram.com/${sourceHandle}/`;

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

  // Clear from Unknown: update external_strategy_signals and paper_trades so the video
  // no longer appears under Unknown (getStrategySignalStatusSummaries + recalculatePerformanceByStrategySource)
  if (vidIds.length > 0) {
    await supabase
      .from('external_strategy_signals')
      .update({ source_name: sourceName, source_url: sourceUrl, updated_at: new Date().toISOString() })
      .in('strategy_video_id', vidIds)
      .eq('source_name', 'Unknown');

    await supabase
      .from('paper_trades')
      .update({ strategy_source: sourceName, strategy_source_url: sourceUrl })
      .in('strategy_video_id', vidIds)
      .eq('strategy_source', 'Unknown');
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
