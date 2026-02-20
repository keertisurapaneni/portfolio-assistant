/**
 * Process pending strategy_video_queue items: create minimal strategy_videos entries.
 * Category (daily_signal vs generic_strategy) is set later when transcript is available.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const INSTAGRAM_REEL = /instagram\.com\/(?:([^/]+)\/)?reel\/([A-Za-z0-9_-]+)/i;
const TWITTER_STATUS = /(?:twitter|x)\.com\/(?:[^/]+\/)?status\/(\d+)/i;
const YOUTUBE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

function parseUrl(url: string): { platform: 'instagram' | 'twitter' | 'youtube'; videoId: string; handle?: string } | null {
  const trimmed = url.trim();
  let m = INSTAGRAM_REEL.exec(trimmed);
  if (m) return { platform: 'instagram', videoId: m[2], handle: m[1] || undefined };

  m = TWITTER_STATUS.exec(trimmed);
  if (m) return { platform: 'twitter', videoId: m[1] };

  m = YOUTUBE.exec(trimmed);
  if (m) return { platform: 'youtube', videoId: m[1] };

  return null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function toSourceName(handle: string): string {
  return handle
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** For instagram.com/reel/ID (no handle in path), fetch page and extract handle */
async function fetchInstagramHandle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    const html = await res.text();
    const ogUrl = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]*)"/i)?.[1] ?? '';
    const m = /instagram\.com\/([^/]+)\/(?:reel|p)\//i.exec(ogUrl);
    if (m?.[1]) return m[1].trim().toLowerCase();

    const profileMatch = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)(?:\/|["'\s>])/);
    if (profileMatch?.[1]) {
      const h = profileMatch[1].toLowerCase();
      if (!['reel', 'p', 'stories', 'explore', 'accounts', 'direct'].includes(h)) return h;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Resolve source_name from handle: use existing strategy_videos if same handle, else humanize handle */
async function resolveSource(
  supabase: ReturnType<typeof createClient>,
  platform: string,
  handle: string | undefined
): Promise<{ source_name: string; source_handle: string | null }> {
  const h = (handle ?? '').trim().toLowerCase();
  if (!h) return { source_name: 'Unknown', source_handle: null };

  const { data: existing } = await supabase
    .from('strategy_videos')
    .select('source_name, source_handle')
    .ilike('source_handle', h)
    .eq('platform', platform)
    .limit(1)
    .maybeSingle();

  if (existing?.source_name) {
    return {
      source_name: existing.source_name.trim(),
      source_handle: (existing.source_handle ?? h).trim() || null,
    };
  }

  return {
    source_name: toSourceName(h),
    source_handle: h,
  };
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

  const { data: pending, error: fetchErr } = await supabase
    .from('strategy_video_queue')
    .select('id, url, platform')
    .eq('status', 'pending')
    .limit(20);

  if (fetchErr) {
    console.error('[process-strategy-video-queue]:', fetchErr);
    return new Response(
      JSON.stringify({ error: fetchErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const items = pending ?? [];
  const results: { id: string; status: 'done' | 'failed'; error?: string }[] = [];

  for (const item of items) {
    const parsed = parseUrl(item.url);
    if (!parsed) {
      await supabase
        .from('strategy_video_queue')
        .update({ status: 'failed', error_message: 'Invalid URL format', processed_at: new Date().toISOString() })
        .eq('id', item.id);
      results.push({ id: item.id, status: 'failed', error: 'Invalid URL format' });
      continue;
    }

    let handle = parsed.handle;
    if (!handle && parsed.platform === 'instagram') {
      handle = (await fetchInstagramHandle(item.url)) ?? undefined;
    }
    const { source_name: sourceName, source_handle: sourceHandle } = await resolveSource(
      supabase,
      parsed.platform,
      handle
    );

    const row = {
      video_id: parsed.videoId,
      platform: parsed.platform,
      source_handle: sourceHandle ?? parsed.handle ?? null,
      source_name: sourceName,
      reel_url: parsed.platform === 'instagram' ? item.url : null,
      canonical_url: parsed.platform !== 'instagram' ? item.url : null,
      video_heading: null,
      strategy_type: null,
      timeframe: null,
      applicable_timeframes: [],
      status: 'tracked',
      ingest_status: 'pending',
    };

    const { data: inserted, error: upsertErr } = await supabase
      .from('strategy_videos')
      .upsert(row, { onConflict: 'platform,video_id', ignoreDuplicates: false })
      .select('id')
      .single();

    if (upsertErr) {
      console.error('[process-strategy-video-queue]:', upsertErr);
      await supabase
        .from('strategy_video_queue')
        .update({ status: 'failed', error_message: upsertErr.message, processed_at: new Date().toISOString() })
        .eq('id', item.id);
      results.push({ id: item.id, status: 'failed', error: upsertErr.message });
      continue;
    }

    await supabase
      .from('strategy_video_queue')
      .update({
        status: 'done',
        strategy_video_id: inserted?.id ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    results.push({ id: item.id, status: 'done' });
  }

  // Trigger transcript ingest (no auto-trader needed — runs in configured worker)
  const ingestUrl = Deno.env.get('INGEST_TRIGGER_URL');
  if (results.length > 0 && ingestUrl?.trim()) {
    fetch(ingestUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'process-strategy-video-queue' }),
    }).catch((e) => console.error('[process-strategy-video-queue] ingest trigger:', e));
  }

  return new Response(
    JSON.stringify({ ok: true, processed: results.length, results }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
