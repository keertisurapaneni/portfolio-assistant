import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface MarketMover {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

serve(async req => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { type } = await req.json();

    if (type !== 'gainers' && type !== 'losers') {
      return new Response(
        JSON.stringify({ error: 'Invalid type. Must be "gainers" or "losers"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use Yahoo Finance predefined screener API (tested and verified working!)
    const scrId = type === 'gainers' ? 'day_gainers' : 'day_losers';
    
    const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved');
    url.searchParams.set('formatted', 'true');
    url.searchParams.set('scrIds', scrId);
    url.searchParams.set('start', '0');
    url.searchParams.set('count', '25');
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');
    url.searchParams.set('corsDomain', 'finance.yahoo.com');

    console.log(`[Market Movers] Fetching ${type} from Yahoo Finance screener`);
    
    // Try with retry — Yahoo Finance can be flaky
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Referer': 'https://finance.yahoo.com/markets/stocks/gainers/',
        },
      });
      if (response.ok) break;
      console.warn(`[Market Movers] Yahoo returned ${response.status} (attempt ${attempt + 1}/2)`);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }

    if (!response || !response.ok) {
      // Return 200 with empty movers instead of 500 — let client handle gracefully
      console.warn(`[Market Movers] Yahoo Finance unavailable for ${type}`);
      return new Response(JSON.stringify({ movers: [], type, cached: false, warning: 'Yahoo Finance temporarily unavailable' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();

    // Parse Yahoo Finance screener response
    const movers: MarketMover[] = [];
    
    if (
      data &&
      data.finance &&
      data.finance.result &&
      data.finance.result[0] &&
      data.finance.result[0].quotes
    ) {
      const quotes = data.finance.result[0].quotes;
      
      for (const quote of quotes) {
        const symbol = quote.symbol;
        const name = quote.shortName || quote.longName || symbol;
        
        // Handle both raw and formatted values from Yahoo
        const price = typeof quote.regularMarketPrice === 'object' 
          ? quote.regularMarketPrice.raw 
          : quote.regularMarketPrice;
        const change = typeof quote.regularMarketChange === 'object'
          ? quote.regularMarketChange.raw
          : quote.regularMarketChange;
        const changePercent = typeof quote.regularMarketChangePercent === 'object'
          ? quote.regularMarketChangePercent.raw
          : quote.regularMarketChangePercent;

        // Only include if we have valid data
        if (symbol && price > 0) {
          movers.push({
            symbol,
            name,
            price,
            change,
            changePercent,
          });
        }
      }
    }

    console.log(`[Market Movers] Fetched ${movers.length} ${type} from Yahoo Finance screener`);

    return new Response(JSON.stringify({ movers, type, cached: false }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[Market Movers] Error:', error);
    // Return 200 with empty data — client handles gracefully
    return new Response(JSON.stringify({ movers: [], warning: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
