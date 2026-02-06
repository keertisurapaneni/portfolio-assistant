// Portfolio Assistant - Secure Stock Data Edge Function
// Proxies Finnhub API requests with server-side caching

import { createClient } from 'jsr:@supabase/supabase-js@2';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// CORS headers for frontend access
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // Will be restricted to specific domain in production
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RequestPayload {
  ticker: string;
  endpoint: 'quote' | 'metrics' | 'recommendations' | 'earnings' | 'news' | 'general_news';
}

interface CacheEntry {
  ticker: string;
  endpoint: string;
  data: any;
  cached_at: string;
}

Deno.serve(async req => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Parse request
    const { ticker, endpoint }: RequestPayload = await req.json();

    // Validate inputs
    if (!ticker || !endpoint) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters: ticker, endpoint' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const validEndpoints = ['quote', 'metrics', 'recommendations', 'earnings', 'news', 'general_news'];
    if (!validEndpoints.includes(endpoint)) {
      return new Response(
        JSON.stringify({ error: `Invalid endpoint. Must be one of: ${validEndpoints.join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // general_news doesn't need a real ticker — use "_MARKET" as cache key
    const symbol = endpoint === 'general_news' ? '_MARKET' : ticker.toUpperCase();

    // Initialize Supabase client (service role for cache write access)
    // Note: Using service role key which is auto-available in Edge Functions
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );

    // Check cache
    const { data: cachedData, error: cacheError } = await supabase
      .from('stock_cache')
      .select('*')
      .eq('ticker', symbol)
      .eq('endpoint', endpoint)
      .single();

    // If cache hit and fresh (<15 min), return cached data
    if (cachedData && !cacheError) {
      const cacheAge = Date.now() - new Date(cachedData.cached_at).getTime();
      if (cacheAge < CACHE_TTL_MS) {
        console.log(`[Cache HIT] ${symbol}/${endpoint} (age: ${Math.round(cacheAge / 1000)}s)`);
        return new Response(
          JSON.stringify({
            ...cachedData.data,
            cached: true,
            cacheAge: Math.round(cacheAge / 1000),
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        console.log(`[Cache STALE] ${symbol}/${endpoint} (age: ${Math.round(cacheAge / 1000)}s)`);
      }
    }

    // Cache miss or stale - fetch from Finnhub
    const finnhubApiKey = Deno.env.get('FINNHUB_API_KEY');
    if (!finnhubApiKey) {
      return new Response(JSON.stringify({ error: 'Finnhub API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build Finnhub API URL based on endpoint
    let apiUrl = '';
    switch (endpoint) {
      case 'quote':
        apiUrl = `${FINNHUB_BASE}/quote?symbol=${symbol}&token=${finnhubApiKey}`;
        break;
      case 'metrics':
        apiUrl = `${FINNHUB_BASE}/stock/metric?symbol=${symbol}&metric=all&token=${finnhubApiKey}`;
        break;
      case 'recommendations':
        apiUrl = `${FINNHUB_BASE}/stock/recommendation?symbol=${symbol}&token=${finnhubApiKey}`;
        break;
      case 'earnings':
        apiUrl = `${FINNHUB_BASE}/stock/earnings?symbol=${symbol}&token=${finnhubApiKey}`;
        break;
      case 'news': {
        // Get news from last 7 days
        const toDate = new Date().toISOString().split('T')[0];
        const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        apiUrl = `${FINNHUB_BASE}/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${finnhubApiKey}`;
        break;
      }
      case 'general_news':
        // Broad market news for macro theme detection (Gold Mines)
        apiUrl = `${FINNHUB_BASE}/news?category=general&token=${finnhubApiKey}`;
        break;
    }

    // Fetch from Finnhub
    console.log(`[Finnhub API] Fetching ${symbol}/${endpoint}`);
    const finnhubResponse = await fetch(apiUrl);

    if (!finnhubResponse.ok) {
      const errorText = await finnhubResponse.text();
      console.error(`[Finnhub API] HTTP ${finnhubResponse.status}: ${errorText}`);

      // If we have stale cache, return it with error flag
      if (cachedData) {
        console.log(`[Fallback] Returning stale cache for ${symbol}/${endpoint}`);
        return new Response(
          JSON.stringify({
            ...cachedData.data,
            cached: true,
            stale: true,
            error: `Finnhub API error (${finnhubResponse.status}). Using cached data.`,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // No cache available
      return new Response(
        JSON.stringify({
          error: `Failed to fetch stock data: ${finnhubResponse.status}`,
          ticker: symbol,
          endpoint,
        }),
        {
          status: finnhubResponse.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const finnhubData = await finnhubResponse.json();

    // Check for Finnhub API errors in response
    if (finnhubData.error) {
      console.error(`[Finnhub API] Error in response: ${finnhubData.error}`);

      // Return stale cache if available
      if (cachedData) {
        return new Response(
          JSON.stringify({
            ...cachedData.data,
            cached: true,
            stale: true,
            error: finnhubData.error,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ error: finnhubData.error, ticker: symbol, endpoint }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update cache with fresh data
    const { error: upsertError } = await supabase.from('stock_cache').upsert(
      {
        ticker: symbol,
        endpoint,
        data: finnhubData,
        cached_at: new Date().toISOString(),
      },
      {
        onConflict: 'ticker,endpoint',
      }
    );

    if (upsertError) {
      console.error(`[Cache UPDATE ERROR] ${symbol}/${endpoint}:`, upsertError);
      // Continue - cache update failure doesn't block returning data
    } else {
      console.log(`[Cache UPDATED] ${symbol}/${endpoint}`);
    }

    // Return fresh data
    return new Response(JSON.stringify({ ...finnhubData, cached: false }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[Edge Function Error]:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
