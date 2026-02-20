/**
 * Fetch YouTube captions for a strategy_video and run metadata extraction.
 * No yt-dlp or ffmpeg needed — uses YouTube's own caption API.
 *
 * POST body: { video_id: string }
 * - video_id: YouTube video ID (e.g. "dQw4w9WgXcQ")
 *
 * Flow:
 * 1. Fetch youtube.com/watch?v=ID → parse ytInitialPlayerResponse for captionTracks
 * 2. Download first English (or any) caption track XML
 * 3. Parse XML → plain text transcript
 * 4. Call extract-strategy-metadata-from-transcript
 * 5. strategy_videos row is updated with transcript + metadata
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const YT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/** Fetch youtube.com/watch page and extract captionTracks from ytInitialPlayerResponse */
async function fetchCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': YT_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`YouTube fetch failed: ${res.status}`);
  const html = await res.text();

  // Extract ytInitialPlayerResponse JSON
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|const|let)\s/s);
  if (!match?.[1]) throw new Error('Could not find ytInitialPlayerResponse in page');

  let playerResponse: Record<string, unknown>;
  try {
    playerResponse = JSON.parse(match[1]);
  } catch {
    throw new Error('Failed to parse ytInitialPlayerResponse');
  }

  const tracks = (
    (playerResponse as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] } } })
      ?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  ) as Array<{ baseUrl?: string; languageCode?: string; kind?: string }>;

  return tracks
    .filter(t => t.baseUrl)
    .map(t => ({
      baseUrl: t.baseUrl!,
      languageCode: t.languageCode ?? '',
      kind: t.kind ?? '',
    }));
}

/** Pick best caption track: prefer manual English, then auto English, then any */
function pickBestTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const manual = tracks.find(t => t.languageCode.startsWith('en') && t.kind !== 'asr');
  if (manual) return manual;
  const auto = tracks.find(t => t.languageCode.startsWith('en'));
  if (auto) return auto;
  return tracks[0];
}

/** Fetch caption XML and parse to plain text */
async function fetchCaptionText(track: CaptionTrack): Promise<string> {
  const url = track.baseUrl.includes('fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=srv3`;
  const res = await fetch(url, {
    headers: { 'User-Agent': YT_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Caption fetch failed: ${res.status}`);
  const xml = await res.text();

  // Parse <text start="..." dur="...">content</text> tags
  const segments: string[] = [];
  const tagRe = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    // Decode HTML entities and strip remaining tags
    const text = m[1]
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<[^>]*>/g, '')
      .replace(/\n/g, ' ')
      .trim();
    if (text) segments.push(text);
  }

  return segments.join(' ').replace(/\s{2,}/g, ' ').trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { video_id?: string };
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

  // Mark as transcribing
  await supabase
    .from('strategy_videos')
    .update({ ingest_status: 'transcribing', ingest_error: null })
    .eq('video_id', videoId)
    .eq('platform', 'youtube');

  let transcript: string;
  try {
    const tracks = await fetchCaptionTracks(videoId);
    const track = pickBestTrack(tracks);
    if (!track) {
      await supabase
        .from('strategy_videos')
        .update({ ingest_status: 'failed', ingest_error: 'No captions available for this video' })
        .eq('video_id', videoId)
        .eq('platform', 'youtube');
      return new Response(
        JSON.stringify({ ok: false, error: 'No captions available for this video' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    transcript = await fetchCaptionText(track);
    if (!transcript) {
      await supabase
        .from('strategy_videos')
        .update({ ingest_status: 'failed', ingest_error: 'Captions were empty' })
        .eq('video_id', videoId)
        .eq('platform', 'youtube');
      return new Response(
        JSON.stringify({ ok: false, error: 'Captions were empty' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (e) {
    const msg = (e as Error).message;
    await supabase
      .from('strategy_videos')
      .update({ ingest_status: 'failed', ingest_error: `Caption fetch failed: ${msg}` })
      .eq('video_id', videoId)
      .eq('platform', 'youtube');
    return new Response(
      JSON.stringify({ ok: false, error: `Caption fetch failed: ${msg}` }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Call extract edge function (handles Groq + DB upsert)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const extractRes = await fetch(
    `${supabaseUrl}/functions/v1/extract-strategy-metadata-from-transcript`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        video_id: videoId,
        platform: 'youtube',
        transcript,
        canonical_url: canonicalUrl,
      }),
      signal: AbortSignal.timeout(40_000),
    }
  );

  if (!extractRes.ok) {
    const err = await extractRes.json().catch(() => ({})) as Record<string, unknown>;
    const msg = String(err?.error ?? `Extract failed: ${extractRes.status}`);
    await supabase
      .from('strategy_videos')
      .update({ ingest_status: 'failed', ingest_error: msg })
      .eq('video_id', videoId)
      .eq('platform', 'youtube');
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const extracted = await extractRes.json();
  return new Response(
    JSON.stringify({ ok: true, transcript_length: transcript.length, extracted }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
