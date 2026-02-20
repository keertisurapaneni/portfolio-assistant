/**
 * Extract strategy video metadata from transcript using Groq (Llama).
 * Called by ingest script after transcribing. Extracts source_name, strategy_type,
 * video_heading, extracted_signals, trade_date, etc. — then upserts to strategy_videos.
 *
 * POST body: {
 *   video_id: string;
 *   platform?: 'instagram' | 'twitter' | 'youtube';
 *   reel_url?: string;
 *   canonical_url?: string;
 *   transcript: string;
 * }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const EXTRACT_SYSTEM = `You extract structured metadata from trading strategy video transcripts.

Return a single JSON object (no markdown, no code block) with these fields. Use null for unknown.

{
  "source_name": "Display name of creator/channel (e.g. 'Somesh | Day Trader | Investor', 'Casper Clipping')",
  "source_handle": "Instagram/Twitter handle if mentioned (e.g. 'kaycapitals', 'casperclipping'). Lowercase, no @.",
  "strategy_type": "daily_signal" | "generic_strategy",
  "video_heading": "Short title summarizing the strategy (e.g. '4 stocks day-trading gameplan for Thursday')",
  "trade_date": "YYYY-MM-DD if date-specific (daily_signal), else null",
  "timeframe": "DAY_TRADE" | "SWING_TRADE" | "LONG_TERM" | null,
  "applicable_timeframes": ["DAY_TRADE"] | ["SWING_TRADE"] | ["DAY_TRADE","SWING_TRADE"] | [],
  "execution_window_et": {"start":"09:35","end":"10:30"} | null,
  "extracted_signals": [{"ticker":"TSLA","longTriggerAbove":414,"longTargets":[416.9,420],"shortTriggerBelow":409,"shortTargets":[405.3,402.65]}] | [],
  "summary": "1-2 sentence summary of the strategy"
}

Rules:
- daily_signal: video gives concrete levels (entry, stop, target) for specific stocks today. Use extracted_signals.
- generic_strategy: general rules, patterns, SMC concepts (no specific levels). extracted_signals = [].
- source_name: from intro ("Hey it's Somesh from Kay Capitals"), outro, or channel branding. Humanize (e.g. "Kay Capitals" → "Somesh | Day Trader | Investor" if known).
- source_handle: Instagram handle if mentioned. Infer from source_name (e.g. "Casper Clipping" → "casperclipping").
- trade_date: only for daily_signal when date is explicit (e.g. "for Thursday", "today's levels").
- execution_window_et: only if time window is specified (e.g. "9:30-9:35 levels", "first candle rule").`;

async function callGroq(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

function parseJson(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  return JSON.parse(cleaned) as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('GROQ_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'GROQ_API_KEY not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body: { video_id?: string; platform?: string; reel_url?: string; canonical_url?: string; transcript?: string };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const video_id = (body.video_id ?? '').trim();
  const transcript = (body.transcript ?? '').trim();
  if (!video_id || !transcript) {
    return new Response(
      JSON.stringify({ error: 'video_id and transcript required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const platform = (body.platform ?? 'instagram') as 'instagram' | 'twitter' | 'youtube';
  const reel_url = (body.reel_url ?? '').trim() || null;
  const canonical_url = (body.canonical_url ?? '').trim() || null;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const userPrompt = `Today's date (ET): ${todayEt}\n\nTranscript:\n\n${transcript}\n\nExtract metadata from this trading strategy video transcript. For trade_date, resolve relative references like "today", "tomorrow", "Friday" to an actual YYYY-MM-DD date using today's date above.`;

  let extracted: Record<string, unknown>;
  try {
    const raw = await callGroq(apiKey, EXTRACT_SYSTEM, userPrompt);
    extracted = parseJson(raw);
  } catch (e) {
    console.error('[extract-strategy-metadata]', e);
    return new Response(
      JSON.stringify({ error: `Extraction failed: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let source_name = String(extracted.source_name ?? '').trim();
  let source_handle = (extracted.source_handle ? String(extracted.source_handle).trim().toLowerCase().replace(/^@+/, '') : null) as string | null;

  if (!source_name) {
    source_name = 'Unknown';
  }

  // Resolve canonical source_name from existing strategy_videos if we have a handle
  if (source_handle) {
    const { data: existing } = await supabase
      .from('strategy_videos')
      .select('source_name, source_handle')
      .ilike('source_handle', source_handle)
      .eq('platform', platform)
      .neq('source_name', 'Unknown')
      .limit(1)
      .maybeSingle();

    if (existing?.source_name) {
      source_name = existing.source_name.trim();
      source_handle = (existing.source_handle ?? source_handle).trim() || null;
    }
  }

  const strategy_type = extracted.strategy_type === 'daily_signal' || extracted.strategy_type === 'generic_strategy'
    ? extracted.strategy_type
    : null;
  const video_heading = extracted.video_heading ? String(extracted.video_heading).trim() : null;
  // Only accept ISO date strings — reject relative values like "Friday", "tomorrow", etc.
  const rawTradeDate = extracted.trade_date ? String(extracted.trade_date).trim() : null;
  const trade_date = rawTradeDate && /^\d{4}-\d{2}-\d{2}$/.test(rawTradeDate) ? rawTradeDate : null;
  const timeframe = extracted.timeframe === 'DAY_TRADE' || extracted.timeframe === 'SWING_TRADE' || extracted.timeframe === 'LONG_TERM'
    ? extracted.timeframe
    : null;
  const applicable_timeframes = Array.isArray(extracted.applicable_timeframes)
    ? extracted.applicable_timeframes.filter((t) => t === 'DAY_TRADE' || t === 'SWING_TRADE')
    : [];
  const execution_window_et = extracted.execution_window_et && typeof extracted.execution_window_et === 'object'
    ? (extracted.execution_window_et as { start?: string; end?: string })
    : null;
  const extracted_signals = Array.isArray(extracted.extracted_signals) ? extracted.extracted_signals : [];
  const summary = extracted.summary ? String(extracted.summary).trim() : null;

  const upsertPayload = {
    video_id,
    platform,
    source_handle,
    source_name,
    reel_url,
    canonical_url,
    video_heading,
    strategy_type,
    timeframe,
    applicable_timeframes,
    execution_window_et,
    trade_date,
    extracted_signals,
    summary,
    transcript,
    ingest_status: 'done',
    ingest_error: null,
    status: 'tracked',
  };

  const { data: upserted, error } = await supabase
    .from('strategy_videos')
    .upsert(upsertPayload, { onConflict: 'platform,video_id', ignoreDuplicates: false })
    .select('id, video_id, platform, source_name')
    .single();

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // For daily_signal videos with extracted signals: auto-import into external_strategy_signals
  // so the auto-trader picks them up on trade_date. Fire-and-forget (non-blocking).
  if (strategy_type === 'daily_signal' && extracted_signals.length > 0) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${supabaseUrl}/functions/v1/import-strategy-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseKey}` },
      body: JSON.stringify({ video_id: video_id, platform }),
    }).catch((e) => console.error('[extract] import-strategy-signals trigger failed:', e));
  }

  return new Response(
    JSON.stringify({
      ok: true,
      strategy_video: upserted,
      extracted: {
        source_name,
        source_handle,
        strategy_type,
        video_heading,
        trade_date,
      },
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
