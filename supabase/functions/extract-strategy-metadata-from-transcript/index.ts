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
  "setup_type": "breakout" | "momentum" | "pullback_vwap" | "range" | null,
  "extracted_signals": [{"ticker":"TSLA","longTriggerAbove":414,"longTargets":[416.9,420],"shortTriggerBelow":409,"shortTargets":[405.3,402.65]}] | [],
  "summary": "1-2 sentence summary of the strategy"
}

Rules:
- daily_signal: video gives concrete levels (entry, stop, target) for specific stocks today. Use extracted_signals.
- generic_strategy: general rules, patterns, SMC concepts (no specific levels). extracted_signals = [].
- source_name: from intro ("Hey it's Somesh from Kay Capitals"), outro, or channel branding. Humanize (e.g. "Kay Capitals" → "Somesh | Day Trader | Investor" if known).
- source_handle: Instagram handle if mentioned. Infer from source_name (e.g. "Casper Clipping" → "casperclipping").
- ticker: MUST be the exact official US exchange ticker symbol. Double-check common names before writing: Meta Platforms = META (not MERA), Alphabet = GOOGL/GOOG, Amazon = AMZN, Microsoft = MSFT, Apple = AAPL, Nvidia = NVDA, Tesla = TSLA, Palantir = PLTR, Coinbase = COIN, MicroStrategy = MSTR, QQQ = QQQ (Nasdaq ETF, NOT "KQQ", "KKI", "QQ", or any variant — always exactly "QQQ"), SPY = SPY (S&P 500 ETF), IWM = IWM (Russell 2000 ETF). If uncertain, omit the signal rather than guess.
- longTriggerAbove / shortTriggerBelow / longTargets / shortTargets: MUST be actual dollar prices, NOT percentages. META trades near $600, TSLA near $300-$500, NVDA near $100-$200, SPY near $500-$700, QQQ near $400-$600. If the numbers you extracted are in single digits or look like percentages (e.g. 5.96, 6.1), you made an error — re-read the transcript and extract the real dollar price. A number like "6.1" for META means nothing; the real level would be something like $610 or $608.
- ATH / all-time-high language: if the transcript says "above ATH" or "new all-time high" for the long trigger without giving a specific number, set longTriggerAbove = shortTriggerBelow (use the short trigger level as a proxy). If shortTriggerBelow is also missing, use shortTargets[0]. Never leave BOTH longTriggerAbove and shortTriggerBelow null when the transcript gives any price levels for that ticker.
- "below X" always maps to shortTriggerBelow=X. "above X" always maps to longTriggerAbove=X. Extract these directly from the transcript — do not leave them null if a number is present.
- trade_date: only for daily_signal when date is explicit (e.g. "for Thursday", "today's levels").
- execution_window_et: only if time window is specified (e.g. "9:30-9:35 levels", "first candle rule").
- setup_type: how the influencer intends execution:
    "breakout"     — enter when price breaks above/below a pre-market high/low with volume (most common for daily signals with trigger levels)
    "momentum"     — buy/short the directional move in the first hour, market order or aggressive limit
    "pullback_vwap"— wait for a pullback to VWAP or a support level before entering (patient entry)
    "range"        — stock is in a range; play the bounce off support or rejection at resistance
    null           — unclear or generic strategy with no specific setup type`;

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

  let body: {
    video_id?: string; platform?: string; reel_url?: string; canonical_url?: string;
    transcript?: string; uploader_name?: string; uploader_handle?: string; description?: string;
  };
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
  // Authoritative creator info from yt-dlp metadata (beats LLM guessing)
  const uploaderName = (body.uploader_name ?? '').trim() || null;
  const uploaderHandle = (body.uploader_handle ?? '').trim().toLowerCase().replace(/^@+/, '') || null;
  const videoDescription = (body.description ?? '').trim() || null;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // ── Step 1: Fetch current state + save transcript immediately ──────────────
  // This ensures ingest_status = 'done' even if the LLM call below fails.
  const { data: current } = await supabase
    .from('strategy_videos')
    .select('id, source_name, source_handle')
    .eq('platform', platform)
    .eq('video_id', video_id)
    .maybeSingle();

  // Preserve existing source/handle so INSERT (new row) never violates NOT NULL on source_name,
  // and UPDATE never clears a manually-assigned source with a blank value.
  const existingSourceName = (current?.source_name ?? '').trim() || 'Unknown';
  const existingSourceHandle = (current?.source_handle ?? '').trim() || null;

  const { data: savedVideo, error: saveErr } = await supabase
    .from('strategy_videos')
    .upsert({
      video_id,
      platform,
      transcript,
      ingest_status: 'done',
      ingest_error: null,
      status: 'tracked',
      source_name: existingSourceName,
      ...(existingSourceHandle ? { source_handle: existingSourceHandle } : {}),
      ...(reel_url ? { reel_url } : {}),
      ...(canonical_url ? { canonical_url } : {}),
    }, { onConflict: 'platform,video_id', ignoreDuplicates: false })
    .select('id, video_id, platform, source_name')
    .single();

  if (saveErr) {
    return new Response(
      JSON.stringify({ error: saveErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // ── Step 2: LLM extraction — transcript already saved, so failures are non-fatal ──
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const contextLines = [
    `Today's date (ET): ${todayEt}`,
    uploaderName ? `Creator name (from platform metadata, authoritative): ${uploaderName}` : null,
    uploaderHandle ? `Creator handle (from platform metadata, authoritative): @${uploaderHandle}` : null,
    videoDescription ? `Video caption/description: ${videoDescription}` : null,
  ].filter(Boolean).join('\n');
  const tomorrowEtForPrompt = (() => {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  })();
  const userPrompt = `${contextLines}\n\nTranscript:\n\n${transcript}\n\nExtract metadata from this trading strategy video transcript.\n\nFor trade_date: videos are often posted the night before for next-day pre-market viewing. Resolve day-of-week references like "Tuesday's trading day", "Monday's gameplan" to the specific date they name — if that date is tomorrow (${tomorrowEtForPrompt}), use tomorrow's date, not today's (${todayEt}). Only use a date further in the future if the transcript explicitly names one. Use the creator name/handle above as-is for source_name/source_handle — do not guess or substitute a different name.`;

  let extracted: Record<string, unknown>;
  try {
    const raw = await callGroq(apiKey, EXTRACT_SYSTEM, userPrompt);
    extracted = parseJson(raw);
  } catch (e) {
    console.error('[extract-strategy-metadata] LLM failed — transcript saved, metadata skipped:', e);
    // Return success: transcript is stored and ingest_status is 'done'
    return new Response(
      JSON.stringify({ ok: true, strategy_video: savedVideo, warning: `LLM extraction failed: ${(e as Error).message}` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let source_name = String(extracted.source_name ?? '').trim();
  let source_handle = (extracted.source_handle ? String(extracted.source_handle).trim().toLowerCase().replace(/^@+/, '') : null) as string | null;

  // yt-dlp metadata beats LLM guessing — use it as authoritative source
  if (uploaderName) source_name = uploaderName;
  if (uploaderHandle) source_handle = uploaderHandle;

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

  // ── Source preservation: never overwrite a manually-assigned source with Unknown ──
  // If the video already has a real source (not Unknown), keep it even if the LLM
  // couldn't identify the source from the transcript.
  const currentSourceName = (current?.source_name ?? '').trim();
  const currentSourceHandle = (current?.source_handle ?? '').trim();
  const hasManualSource = currentSourceName && currentSourceName !== 'Unknown';

  if (!source_name || source_name === 'Unknown') {
    if (hasManualSource) {
      // Keep the manually-assigned source
      source_name = currentSourceName;
      source_handle = currentSourceHandle || source_handle;
    } else {
      source_name = 'Unknown';
    }
  }

  const extractedStrategyType = extracted.strategy_type === 'daily_signal' || extracted.strategy_type === 'generic_strategy'
    ? extracted.strategy_type : null;
  const strategy_type = extractedStrategyType;
  const video_heading = extracted.video_heading ? String(extracted.video_heading).trim() : null;
  // Only accept ISO date strings — reject relative values like "Friday", "tomorrow", etc.
  const rawTradeDate = extracted.trade_date ? String(extracted.trade_date).trim() : null;
  let trade_date = rawTradeDate && /^\d{4}-\d{2}-\d{2}$/.test(rawTradeDate) ? rawTradeDate : null;
  // For daily_signal videos: clamp to tomorrow if the LLM returned a date more than 1 day out.
  // Creators often upload the next trading day's gameplan the night before (pre-market), so a
  // date 1 calendar day in the future is valid and should NOT be clamped. Anything further is
  // an LLM inference error.
  if (trade_date && extractedStrategyType === 'daily_signal') {
    const tomorrowEt = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
    );
    tomorrowEt.setDate(tomorrowEt.getDate() + 1);
    const tomorrowEtStr = tomorrowEt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (trade_date > tomorrowEtStr) {
      console.warn(`[extract] trade_date ${trade_date} is >1 day in the future for daily_signal — clamping to today (${todayEt})`);
      trade_date = todayEt;
    }
  }
  const timeframe = extracted.timeframe === 'DAY_TRADE' || extracted.timeframe === 'SWING_TRADE' || extracted.timeframe === 'LONG_TERM'
    ? extracted.timeframe
    : null;
  const applicable_timeframes = Array.isArray(extracted.applicable_timeframes)
    ? extracted.applicable_timeframes.filter((t) => t === 'DAY_TRADE' || t === 'SWING_TRADE')
    : [];
  const execution_window_et = extracted.execution_window_et && typeof extracted.execution_window_et === 'object'
    ? (extracted.execution_window_et as { start?: string; end?: string })
    : null;
  // Correct known transcription/OCR misreads for well-known tickers
  const TICKER_CORRECTIONS: Record<string, string> = {
    KKI: 'QQQ', KQQ: 'QQQ', QQ: 'QQQ', KQQQ: 'QQQ',
    MERA: 'META', NVDIA: 'NVDA', NFDA: 'NVDA',
    BLTR: 'PLTR', PLRT: 'PLTR',  // P/B OCR misread on Palantir
    TSLA: 'TSLA', // identity — keep common ones to prevent further drift
  };
  const rawSignals = Array.isArray(extracted.extracted_signals) ? extracted.extracted_signals : [];
  const extracted_signals = rawSignals.map((s: Record<string, unknown>) => {
    const ticker = String(s.ticker ?? '').trim().toUpperCase();
    return { ...s, ticker: TICKER_CORRECTIONS[ticker] ?? ticker };
  });
  const summary = extracted.summary ? String(extracted.summary).trim() : null;
  const VALID_SETUP_TYPES = ['breakout', 'momentum', 'pullback_vwap', 'range'] as const;
  const setup_type = VALID_SETUP_TYPES.includes(extracted.setup_type as typeof VALID_SETUP_TYPES[number])
    ? (extracted.setup_type as string)
    : null;

  const { data: upserted, error } = await supabase
    .from('strategy_videos')
    .upsert({
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
      setup_type,
      summary,
      transcript,
      ingest_status: 'done',
      ingest_error: null,
      status: 'tracked',
    }, { onConflict: 'platform,video_id', ignoreDuplicates: false })
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
