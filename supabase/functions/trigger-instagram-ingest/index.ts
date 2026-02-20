/**
 * Trigger GitHub Actions to ingest Instagram strategy videos.
 * Requires GITHUB_TOKEN (PAT with `repo` scope) and GITHUB_REPO set as Supabase secrets.
 *
 * POST body: { video_ids?: string[] }
 *   - video_ids: specific Instagram reel IDs to ingest (optional)
 *   - If omitted, GitHub Actions will process all pending strategy_videos
 */

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

  const githubToken = Deno.env.get('GITHUB_TOKEN');
  const githubRepo = Deno.env.get('GITHUB_REPO') ?? 'keertisurapaneni/portfolio-assistant';

  if (!githubToken) {
    return new Response(JSON.stringify({ error: 'GITHUB_TOKEN secret not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { video_ids?: string[] };
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }

  const videoIds = (body.video_ids ?? []).filter((id) => typeof id === 'string' && id.trim());

  const dispatchPayload = {
    event_type: 'ingest-instagram',
    client_payload: {
      video_ids: videoIds.join(','),
    },
  };

  const ghRes = await fetch(`https://api.github.com/repos/${githubRepo}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'portfolio-assistant-supabase',
    },
    body: JSON.stringify(dispatchPayload),
  });

  if (!ghRes.ok) {
    const errText = await ghRes.text().catch(() => '');
    return new Response(
      JSON.stringify({ error: `GitHub dispatch failed: ${ghRes.status} ${errText}` }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      triggered: true,
      video_ids: videoIds,
      repo: githubRepo,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
