import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface YahooNewsItem {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: number;
  type: string;
  relatedTickers?: string[];
}

interface NewsItem {
  headline: string;
  source: string;
  url: string;
  datetime: number;
}

// Ticker aliases: some tickers have alternate symbols or common company names
const TICKER_ALIASES: Record<string, string[]> = {
  GOOGL: ['GOOG', 'google', 'alphabet'],
  GOOG: ['GOOGL', 'google', 'alphabet'],
  META: ['meta', 'facebook', 'zuckerberg'],
  AMZN: ['amazon', 'bezos'],
  AAPL: ['apple'],
  MSFT: ['microsoft'],
  NVDA: ['nvidia', 'jensen'],
  TSLA: ['tesla', 'musk'],
  NFLX: ['netflix'],
  CRM: ['salesforce'],
  AVGO: ['broadcom'],
  AMD: ['amd'],
  INTC: ['intel'],
  ORCL: ['oracle'],
  ADBE: ['adobe'],
  RBRK: ['rubrik'],
  SNOW: ['snowflake'],
  PLTR: ['palantir'],
  UBER: ['uber'],
  ABNB: ['airbnb'],
  SQ: ['square', 'block inc'],
  SHOP: ['shopify'],
  COIN: ['coinbase'],
  PYPL: ['paypal'],
  DIS: ['disney'],
  JPM: ['jpmorgan', 'jp morgan', 'jamie dimon'],
  BAC: ['bank of america'],
  WMT: ['walmart'],
  COST: ['costco'],
  HD: ['home depot'],
  V: ['visa'],
  MA: ['mastercard'],
  JNJ: ['johnson & johnson', 'johnson and johnson'],
  PFE: ['pfizer'],
  UNH: ['unitedhealth'],
  XOM: ['exxon'],
  CVX: ['chevron'],
};

function isAboutTicker(item: YahooNewsItem, symbol: string): boolean {
  const upperSymbol = symbol.toUpperCase();
  const relatedTickers = item.relatedTickers || [];
  const headlineLower = item.title.toLowerCase();

  // 1. Strongest signal: ticker is the PRIMARY subject (first relatedTicker)
  if (relatedTickers.length > 0) {
    const primary = relatedTickers[0].toUpperCase();
    if (primary === upperSymbol) return true;

    // Check aliases (e.g., GOOGL search returns GOOG as primary)
    const aliases = TICKER_ALIASES[upperSymbol] || [];
    if (aliases.some(a => a.toUpperCase() === primary)) return true;
  }

  // 2. Strong signal: headline explicitly mentions the ticker or company name
  const searchTerms = [upperSymbol.toLowerCase()];
  const aliases = TICKER_ALIASES[upperSymbol] || [];
  searchTerms.push(...aliases.map(a => a.toLowerCase()));

  for (const term of searchTerms) {
    if (headlineLower.includes(term)) return true;
  }

  // 3. Not about this ticker - skip
  return false;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { symbol } = await req.json();

    if (!symbol || typeof symbol !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Symbol is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const upperSymbol = symbol.toUpperCase();
    console.log(`[Yahoo News] Fetching news for ${upperSymbol}`);

    // Fetch more results so we have a bigger pool to filter from
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${upperSymbol}&quotesCount=0&newsCount=20`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance API returned ${response.status}`);
    }

    const data = await response.json();
    const newsItems: NewsItem[] = [];

    if (data?.news && Array.isArray(data.news)) {
      for (const item of data.news as YahooNewsItem[]) {
        if (!isAboutTicker(item, upperSymbol)) {
          console.log(`[Yahoo News] Skipped: "${item.title.substring(0, 50)}..." (primary: ${item.relatedTickers?.[0] || '?'})`);
          continue;
        }

        newsItems.push({
          headline: item.title,
          source: item.publisher || 'Yahoo Finance',
          url: item.link,
          datetime: item.providerPublishTime,
        });
      }
    }

    console.log(`[Yahoo News] Found ${newsItems.length} relevant news items for ${upperSymbol} (filtered from ${data?.news?.length || 0} total)`);

    return new Response(
      JSON.stringify({ news: newsItems, symbol: upperSymbol, cached: false }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[Yahoo News] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to fetch news' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
