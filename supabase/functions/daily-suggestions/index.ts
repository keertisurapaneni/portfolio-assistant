// Daily Suggestions Cache Edge Function
// GET: Return today's cached suggestions for a given category (default: 'auto')
// POST: Store suggestions for today+category (first visitor generates, others read)
// Supports per-category caching via ?category= query param (GET) or body.category (POST)

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
  const url = new URL(req.url);

  try {
    // ── GET: Return today's cached suggestions for a category ──
    if (req.method === 'GET') {
      const category = url.searchParams.get('category') || 'auto';

      const { data, error } = await supabase
        .from('daily_suggestions')
        .select('data, created_at')
        .eq('suggestion_date', today)
        .eq('category', category)
        .single();

      if (error || !data) {
        // Return 200 with cached:false instead of 404 to avoid noisy browser console errors
        return new Response(
          JSON.stringify({ cached: false, date: today, category }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[Daily Suggestions] Cache HIT for ${today} category=${category}`);
      return new Response(
        JSON.stringify({ cached: true, date: today, category, data: data.data, created_at: data.created_at }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── POST: Store today's suggestions for a category ──
    if (req.method === 'POST') {
      const body = await req.json();
      const category = body.category || 'auto';

      if (!body.data) {
        return new Response(
          JSON.stringify({ error: 'Missing "data" field in request body' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if today's data already exists for this category (race condition guard)
      const { data: existing } = await supabase
        .from('daily_suggestions')
        .select('id')
        .eq('suggestion_date', today)
        .eq('category', category)
        .single();

      if (existing) {
        console.log(`[Daily Suggestions] Data for ${today} category=${category} already exists, skipping write`);
        return new Response(
          JSON.stringify({ stored: false, reason: 'already_exists', date: today, category }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Store the suggestions
      const { error: insertError } = await supabase
        .from('daily_suggestions')
        .insert({
          suggestion_date: today,
          category,
          data: body.data,
        });

      if (insertError) {
        // Could be a race condition (another request inserted first)
        if (insertError.code === '23505') {
          console.log(`[Daily Suggestions] Race condition — data already stored for ${today} category=${category}`);
          return new Response(
            JSON.stringify({ stored: false, reason: 'already_exists', date: today, category }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        console.error(`[Daily Suggestions] Insert error:`, insertError);
        return new Response(
          JSON.stringify({ error: 'Failed to store suggestions', details: insertError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Clean up old entries (keep last 7 days — all categories)
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7);
      const cutoff = cutoffDate.toISOString().split('T')[0];

      await supabase
        .from('daily_suggestions')
        .delete()
        .lt('suggestion_date', cutoff);

      console.log(`[Daily Suggestions] Stored data for ${today} category=${category}`);
      return new Response(
        JSON.stringify({ stored: true, date: today, category }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── DELETE: Clear today's cache (for regeneration after bug fixes) ──
    if (req.method === 'DELETE') {
      const category = url.searchParams.get('category');

      // If category specified, only clear that category; otherwise clear all for today
      let query = supabase
        .from('daily_suggestions')
        .delete()
        .eq('suggestion_date', today);

      if (category) {
        query = query.eq('category', category);
      }

      const { error: deleteError } = await query;

      if (deleteError) {
        console.error(`[Daily Suggestions] Delete error:`, deleteError);
        return new Response(
          JSON.stringify({ error: 'Failed to clear cache', details: deleteError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[Daily Suggestions] Cleared cache for ${today}${category ? ` category=${category}` : ' (all categories)'}`);
      return new Response(
        JSON.stringify({ cleared: true, date: today, category: category || 'all' }),
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
