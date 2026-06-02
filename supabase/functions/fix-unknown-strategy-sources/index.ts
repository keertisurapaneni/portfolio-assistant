/**
 * Fix strategy_videos with source_name = 'Unknown': re-resolve source from URL.
 * Call POST to repair misclassified videos.
 *
 * Resolution order:
 *  1. source_handle already set in DB → use it directly
 *  2. Instagram oEmbed API → returns author_name + author_url (reliable, no auth needed)
 *  3. Handle in URL path regex (for URLs like instagram.com/handle/reel/ID)
 *  4. Full page HTML fetch → last resort, often 403'd by Instagram
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const INSTAGRAM_REEL = /instagram\.com\/(?:([^/]+)\/)?reels?\/([A-Za-z0-9_-]+)/i;

const IG_SYSTEM_PATHS = new Set([
  'reel', 'p', 'stories', 'explore', 'accounts', 'direct', 'static',
  'rsrc.php', 'favicon.ico', 'about', 'legal', 'privacy', 'help',
]);

function isIgSystemPath(handle: string): boolean {
  const h = handle.toLowerCase();
  if (IG_SYSTEM_PATHS.has(h)) return true;
  if (/\.[a-z]{2,4}$/.test(h)) return true;
  return false;
}

function toSourceName(handle: string): string {
  return handle
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Instagram oEmbed API — public, no auth, returns author_name + author_url.
 * This is the most reliable way to get the creator handle server-side.
 * Returns { handle, displayName } or null if unavailable.
 */
async function resolveViaOEmbed(reelUrl: string): Promise<{ handle: string; displayName: string } | null> {
  try {
    const oembedUrl = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(reelUrl)}`;
    const res = await fetch(oembedUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { author_name?: string; author_url?: string };
    const authorUrl = data.author_url ?? '';
    // author_url is like https://www.instagram.com/kianstrades — extract handle
    const m = /instagram\.com\/([a-zA-Z0-9_.]+)\/?$/.exec(authorUrl);
    const handle = m?.[1]?.toLowerCase() ?? data.author_name?.toLowerCase() ?? null;
    if (!handle || isIgSystemPath(handle)) return null;
    const displayName = data.author_name ?? handle;
    return { handle, displayName };
  } catch {
    return null;
  }
}

/** Fallback: extract handle from URL path or page HTML */
async function extractInstagramHandleFallback(url: string): Promise<string | null> {
  // Try URL path regex first (fast, no network)
  const m = INSTAGRAM_REEL.exec(url);
  if (m?.[1] && !isIgSystemPath(m[1])) return m[1].trim().toLowerCase();

  // Full page fetch — often 403'd but worth trying
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    const html = await res.text();
    const ogUrl = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]*)"/i)?.[1] ?? '';
    const m2 = /instagram\.com\/([^/]+)\/(?:reels?|p)\//i.exec(ogUrl);
    if (m2?.[1] && !isIgSystemPath(m2[1])) return m2[1].trim().toLowerCase();
    const profileMatch = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)(?:\/|["'\s>])/);
    if (profileMatch?.[1] && !isIgSystemPath(profileMatch[1])) return profileMatch[1].trim().toLowerCase();
  } catch {
    // ignore
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
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
    .select('id, video_id, platform, reel_url, canonical_url, source_handle')
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
    if (row.platform !== 'instagram') {
      results.push({ video_id: row.video_id, source_name: 'Unknown', status: 'failed' });
      continue;
    }

    // Reconstruct reel_url from video_id if neither URL field is populated,
    // and backfill it so future calls don't have to reconstruct.
    let url = (row.reel_url ?? row.canonical_url ?? '').trim();
    if (!url && row.video_id) {
      url = `https://www.instagram.com/reel/${row.video_id}/`;
      await supabase.from('strategy_videos').update({ reel_url: url }).eq('id', row.id);
    }

    // Resolution order: stored handle → oEmbed → URL/page fallback
    let handle: string | null = (row.source_handle ?? '').trim().toLowerCase() || null;
    let displayName: string | null = null;

    if (!handle && url) {
      const oembed = await resolveViaOEmbed(url);
      if (oembed) {
        handle = oembed.handle;
        displayName = oembed.displayName;
      }
    }

    if (!handle && url) {
      handle = await extractInstagramHandleFallback(url);
    }

    if (!handle) {
      results.push({ video_id: row.video_id, source_name: 'Unknown', status: 'failed' });
      continue;
    }

    // Look up canonical source_name from existing videos with this handle
    const { data: existing } = await supabase
      .from('strategy_videos')
      .select('source_name, source_handle')
      .ilike('source_handle', handle)
      .eq('platform', 'instagram')
      .neq('source_name', 'Unknown')
      .limit(1)
      .maybeSingle();

    // Prefer existing canonical name → oEmbed display name → humanized handle
    const sourceName = existing?.source_name?.trim()
      ?? (displayName && displayName !== handle ? toSourceName(displayName) : null)
      ?? toSourceName(handle);
    const sourceHandle = existing?.source_handle ?? handle;

    const { error: updateErr } = await supabase
      .from('strategy_videos')
      .update({ source_name: sourceName, source_handle: sourceHandle, updated_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateErr) {
      results.push({ video_id: row.video_id, source_name: 'Unknown', status: 'failed' });
    } else {
      const vidId = (row.video_id ?? '').trim();
      const sourceUrl = `https://www.instagram.com/${sourceHandle}/`;
      if (vidId) {
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
      results.push({ video_id: row.video_id, source_name: sourceName, status: 'fixed' });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, fixed: results.filter(r => r.status === 'fixed').length, results }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
