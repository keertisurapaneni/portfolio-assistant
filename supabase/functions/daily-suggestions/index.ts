// Daily Suggestions Cache Edge Function
// GET: Return today's cached suggestions (or 404 if none)
// POST: Store suggestions for today (first visitor generates, others read)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD in UTC
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const today = getTodayDate();

  try {
    // ── GET: Return today's cached suggestions ──
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('daily_suggestions')
        .select('data, created_at')
        .eq('suggestion_date', today)
        .single();

      if (error || !data) {
        // Return 200 with cached:false instead of 404 to avoid noisy browser console errors
        return new Response(
          JSON.stringify({ cached: false, date: today }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[Daily Suggestions] Cache HIT for ${today}`);
      return new Response(
        JSON.stringify({ cached: true, date: today, data: data.data, created_at: data.created_at }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── POST: Store today's suggestions ──
    if (req.method === 'POST') {
      const body = await req.json();

      if (!body.data) {
        return new Response(
          JSON.stringify({ error: 'Missing "data" field in request body' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if today's data already exists (race condition guard)
      const { data: existing } = await supabase
        .from('daily_suggestions')
        .select('id')
        .eq('suggestion_date', today)
        .single();

      if (existing) {
        console.log(`[Daily Suggestions] Data for ${today} already exists, skipping write`);
        return new Response(
          JSON.stringify({ stored: false, reason: 'already_exists', date: today }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Store the suggestions
      const { error: insertError } = await supabase
        .from('daily_suggestions')
        .insert({
          suggestion_date: today,
          data: body.data,
        });

      if (insertError) {
        // Could be a race condition (another request inserted first)
        if (insertError.code === '23505') {
          console.log(`[Daily Suggestions] Race condition — data already stored for ${today}`);
          return new Response(
            JSON.stringify({ stored: false, reason: 'already_exists', date: today }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        console.error(`[Daily Suggestions] Insert error:`, insertError);
        return new Response(
          JSON.stringify({ error: 'Failed to store suggestions', details: insertError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Clean up old entries (keep last 7 days)
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7);
      const cutoff = cutoffDate.toISOString().split('T')[0];

      await supabase
        .from('daily_suggestions')
        .delete()
        .lt('suggestion_date', cutoff);

      console.log(`[Daily Suggestions] Stored data for ${today}`);
      return new Response(
        JSON.stringify({ stored: true, date: today }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Daily Suggestions] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
