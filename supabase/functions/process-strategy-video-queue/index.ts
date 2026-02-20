/**
 * Process pending strategy_video_queue items: create strategy_videos entries with AI classification.
 * Fetches page metadata, classifies as daily_signal or generic_strategy via Gemini, then upserts.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const INSTAGRAM_REEL = /instagram\.com\/(?:([^/]+)\/)?reel\/([A-Za-z0-9_-]+)/i;
const TWITTER_STATUS = /(?:twitter|x)\.com\/(?:[^/]+\/)?status\/(\d+)/i;
const YOUTUBE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

const UA = 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0; +https://github.com/portfolio-assistant)';

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

function toSourceName(handle: string | undefined): string {
  if (!handle || !handle.trim()) return 'Unknown';
  return handle
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function fetchVideoMetadata(url: string): Promise<{ title: string; description: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    const html = await res.text();
    const title = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1]?.trim() ?? '';
    const desc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i)?.[1]?.trim() ?? '';
    return { title, description: desc };
  } catch {
    return { title: '', description: '' };
  }
}

async function classifyStrategyType(
  title: string,
  description: string,
  url: string,
  apiKey: string
): Promise<'daily_signal' | 'generic_strategy'> {
  const text = [title, description].filter(Boolean).join('\n').trim() || url;
  if (!text) return 'generic_strategy';

  const prompt = `Classify this trading video into exactly one category.

daily_signal: Video has concrete stock levels for today — specific tickers with entry price, stop loss, target (e.g. "TSLA long above 414, target 420", "SPY short below 683").
generic_strategy: General rules, patterns, or frameworks — no specific stock levels (e.g. candlestick rules, first candle rule, SMC concepts, general setups).

Video info:
${text.slice(0, 800)}

Reply with ONLY one word: daily_signal or generic_strategy`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 20 },
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) return 'generic_strategy';
    const data = await res.json();
    const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim().toLowerCase();
    if (raw.includes('daily_signal')) return 'daily_signal';
    return 'generic_strategy';
  } catch {
    return 'generic_strategy';
  }
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
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
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

    const sourceName = toSourceName(parsed.handle);
    let strategyType: 'daily_signal' | 'generic_strategy' = 'generic_strategy';
    if (geminiKey) {
      const { title, description } = await fetchVideoMetadata(item.url);
      strategyType = await classifyStrategyType(title, description, item.url, geminiKey);
    }

    const row = {
      video_id: parsed.videoId,
      platform: parsed.platform,
      source_handle: parsed.handle ?? null,
      source_name: sourceName,
      reel_url: parsed.platform === 'instagram' ? item.url : null,
      canonical_url: parsed.platform !== 'instagram' ? item.url : null,
      video_heading: null,
      strategy_type: strategyType,
      timeframe: null,
      applicable_timeframes: [],
      status: 'tracked',
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
        strategy_type: strategyType,
        processed_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    results.push({ id: item.id, status: 'done' });
  }

  return new Response(
    JSON.stringify({ ok: true, processed: results.length, results }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
