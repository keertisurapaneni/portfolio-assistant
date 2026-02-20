// SPY + VIX regime — replaces localhost:3001/api/regime/spy and /quote/VIX, /quote/SPY.
// GET — returns { price, sma200, belowSma200, vix } for Gold Mine block + regime display.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchVix(): Promise<number | null> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=1m&includePrePost=false';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta ?? {};
    const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
    if (price != null && price > 0) return price;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    return closes.length > 0 ? closes[closes.length - 1] : null;
  } catch {
    return null;
  }
}

async function fetchSpyRegime(): Promise<{ price: number; sma200: number; belowSma200: boolean; vix: number | null } | null> {
  try {
    const [spyRes, vix] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d&includePrePost=false', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
      }),
      fetchVix(),
    ]);
    if (!spyRes.ok) return null;
    const data = await spyRes.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    if (closes.length < 200) return null;
    const price = closes[closes.length - 1];
    const sma200 = closes.slice(-200).reduce((a: number, b: number) => a + b, 0) / 200;
    const belowSma200 = price < sma200;
    return { price, sma200, belowSma200, vix };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const regime = await fetchSpyRegime();
    if (!regime) {
      return new Response(
        JSON.stringify({ price: null, sma200: null, belowSma200: null, vix: null, error: 'Could not fetch data' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        price: regime.price,
        sma200: regime.sma200,
        belowSma200: regime.belowSma200,
        vix: regime.vix,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[regime-spy]:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch regime' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
