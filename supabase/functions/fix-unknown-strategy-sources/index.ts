/**
 * Fix strategy_videos with source_name = 'Unknown': re-resolve source from URL.
 * Call POST to repair misclassified videos.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const INSTAGRAM_REEL = /instagram\.com\/(?:([^/]+)\/)?reel\/([A-Za-z0-9_-]+)/i;

function toSourceName(handle: string): string {
  return handle
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Extract handle from Instagram URL or page HTML */
async function extractInstagramHandle(url: string): Promise<string | null> {
  const m = INSTAGRAM_REEL.exec(url);
  if (m?.[1]) return m[1].trim().toLowerCase();

  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    const html = await res.text();
    const ogUrl = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]*)"/i)?.[1] ?? '';
    const m2 = /instagram\.com\/([^/]+)\/(?:reel|p)\//i.exec(ogUrl);
    if (m2?.[1]) return m2[1].trim().toLowerCase();

    const profileMatch = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)(?:\/|["'\s>])/);
    if (profileMatch?.[1] && !['reel', 'p', 'stories', 'explore', 'accounts'].includes(profileMatch[1].toLowerCase())) {
      return profileMatch[1].trim().toLowerCase();
    }
  } catch {
    // ignore
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: unknowns, error: fetchErr } = await supabase
    .from('strategy_videos')
    .select('id, video_id, platform, reel_url, canonical_url')
    .eq('status', 'tracked')
    .eq('source_name', 'Unknown')
    .limit(50);

  if (fetchErr || !unknowns?.length) {
    return new Response(
      JSON.stringify({ ok: true, fixed: 0, message: unknowns?.length === 0 ? 'No Unknown sources to fix' : fetchErr?.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const results: { video_id: string; source_name: string; status: 'fixed' | 'failed' }[] = [];

  for (const row of unknowns) {
    const url = (row.reel_url ?? row.canonical_url ?? '').trim();
    if (!url || row.platform !== 'instagram') {
      results.push({ video_id: row.video_id, source_name: 'Unknown', status: 'failed' });
      continue;
    }

    const handle = await extractInstagramHandle(url);
    if (!handle) {
      results.push({ video_id: row.video_id, source_name: 'Unknown', status: 'failed' });
      continue;
    }

    const { data: existing } = await supabase
      .from('strategy_videos')
      .select('source_name, source_handle')
      .ilike('source_handle', handle)
      .eq('platform', 'instagram')
      .neq('source_name', 'Unknown')
      .limit(1)
      .maybeSingle();

    const sourceName = existing?.source_name?.trim() ?? toSourceName(handle);
    const sourceHandle = existing?.source_handle ?? handle;

    const { error: updateErr } = await supabase
      .from('strategy_videos')
      .update({ source_name: sourceName, source_handle: sourceHandle, updated_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateErr) {
      results.push({ video_id: row.video_id, source_name: 'Unknown', status: 'failed' });
    } else {
      results.push({ video_id: row.video_id, source_name: sourceName, status: 'fixed' });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, fixed: results.filter(r => r.status === 'fixed').length, results }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
