/**
 * Trigger transcript ingest by calling an external worker URL.
 * Called by frontend after adding videos, or by process-strategy-video-queue.
 * No auto-trader dependency — ingest runs in the configured worker.
 *
 * Requires: INGEST_TRIGGER_URL (Supabase secret) = URL of ingest worker (e.g. Vercel api/run_ingest)
 */

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

  const url = Deno.env.get('INGEST_TRIGGER_URL');
  if (!url?.trim()) {
    return new Response(
      JSON.stringify({
        ok: false,
        triggered: false,
        message: 'INGEST_TRIGGER_URL not configured. Set it to your ingest worker URL (e.g. Vercel api/run_ingest).',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'trigger-transcript-ingest' }),
      signal: AbortSignal.timeout(5_000),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        triggered: true,
        workerStatus: res.status,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[trigger-transcript-ingest]', e);
    return new Response(
      JSON.stringify({
        ok: false,
        triggered: false,
        error: (e as Error).message,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
