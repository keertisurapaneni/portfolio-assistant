/**
 * Stock API service using Supabase Edge Function
 * Proxies Finnhub API calls through secure Edge Function with server-side caching
 */

const EDGE_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-stock-data`;
const YAHOO_NEWS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-yahoo-news`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Client-side cache to avoid redundant Edge Function calls
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 1000 * 60 * 5; // 5 minutes (Edge Function has its own 15-min cache)

// Rate limiting (conservative client-side throttle)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // 100ms between requests

// ============================================
// TYPE DEFINITIONS
// ============================================

export interface QuarterlyFinancials {
  date: string;
  period: string;
  fiscalYear: string;
  eps: number;
  revenue: number;
  netMargin: number;
}

export interface AnalystRating {
  rating: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  targetMean: number;
  targetHigh: number;
  targetLow: number;
}

export interface NewsItem {
  headline: string;
  summary?: string;
  source: string;
  datetime: number; // Unix timestamp
  url: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
}

export interface StockData {
  ticker: string;
  name: string;
  currentPrice: number;
  change: number;
  changePercent: number;
  volume: number; // Trading volume
  marketCap: number;
  peRatio: number | null;
  eps: number | null;
  roe: number | null;
  profitMargin: number | null;
  operatingMargin: number | null;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  beta: number | null;
  sector: string;
  // Calculated scores
  qualityScore: number;
  momentumScore: number;
  earningsScore: number;
  analystScore: number;
  // Raw data for display
  quarterlyEPS: QuarterlyFinancials[];
  analystRating: AnalystRating | null;
  recentNews: NewsItem[]; // Last 3 news items for context
}

// ============================================
// EDGE FUNCTION API
// ============================================

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }

  lastRequestTime = Date.now();
  return fetch(url, options);
}

async function fetchFromEdge<T>(
  ticker: string,
  endpoint: 'quote' | 'metrics' | 'recommendations' | 'earnings' | 'news',
  cacheKey: string
): Promise<T | null> {
  // Check client-side cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[Edge API] Using client cache for ${cacheKey}`);
    return cached.data as T;
  }

  try {
    console.log(`[Edge API] Fetching ${ticker}/${endpoint}`);

    const response = await rateLimitedFetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ ticker, endpoint }),
    });

    if (!response.ok) {
      console.error(`[Edge API] HTTP error ${response.status}`);
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error(`[Edge API] Error:`, errorData);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[Edge API] API error:`, data.error);
      // If it's cached/stale data with an error, still return it
      if (data.cached) {
        cache.set(cacheKey, { data, timestamp: Date.now() });
        return data as T;
      }
      return null;
    }

    // Cache the result
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data as T;
  } catch (error) {
    console.error(`[Edge API] Fetch error:`, error);
    return null;
  }
}

async function fetchYahooNews(ticker: string): Promise<NewsItem[]> {
  const cacheKey = `yahoo-news-${ticker}`;

  // Check client-side cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[Yahoo News] Using client cache for ${ticker}`);
    return cached.data as NewsItem[];
  }

  try {
    console.log(`[Yahoo News] Fetching news for ${ticker}`);

    const response = await rateLimitedFetch(YAHOO_NEWS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ symbol: ticker }),
    });

    if (!response.ok) {
      console.error(`[Yahoo News] HTTP error ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[Yahoo News] API error:`, data.error);
      return [];
    }

    const newsItems = data.news || [];
    console.log(`[Yahoo News] Fetched ${newsItems.length} news items for ${ticker}`);

    // Cache the result
    cache.set(cacheKey, { data: newsItems, timestamp: Date.now() });
    return newsItems;
  } catch (error) {
    console.error(`[Yahoo News] Fetch error:`, error);
    return [];
  }
}

// ============================================
// FINNHUB RESPONSE TYPES (same as before)
// ============================================

interface FinnhubQuote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Percent change
  h: number; // High
  l: number; // Low
  o: number; // Open
  pc: number; // Previous close
  t?: number; // Timestamp
  v?: number; // Volume
}

interface FinnhubMetrics {
  metric: {
    '52WeekHigh': number;
    '52WeekLow': number;
    beta: number;
    peAnnual?: number;
    peTTM?: number;
    epsAnnual?: number;
    epsTTM?: number;
    epsExclExtraItemsTTM?: number;
    marketCapitalization?: number;
    netProfitMarginAnnual?: number;
    netProfitMarginTTM?: number;
    operatingMarginAnnual?: number;
    operatingMarginTTM?: number;
    roaAnnual?: number;
    roeTTM?: number;
    roeAnnual?: number;
    revenueGrowthQuarterlyYoy?: number;
    revenueGrowthTTMYoy?: number;
    epsGrowthQuarterlyYoy?: number;
    epsGrowthTTMYoy?: number;
    grossMarginAnnual?: number;
    grossMarginTTM?: number;
  };
}

interface FinnhubRecommendation {
  buy: number;
  hold: number;
  sell: number;
  strongBuy: number;
  strongSell: number;
  period: string;
  symbol: string;
}

interface FinnhubEarnings {
  actual: number;
  estimate: number;
  period: string;
  quarter: number;
  surprise: number;
  surprisePercent: number;
  symbol: string;
  year: number;
}

interface FinnhubNews {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

// ============================================
// SCORE CALCULATION FUNCTIONS (unchanged)
// ============================================

function calculateQualityScore(metrics: FinnhubMetrics['metric'] | null): number {
  if (!metrics) return 50;

  let score = 50;

  // EPS check
  const eps = metrics.epsTTM ?? metrics.epsExclExtraItemsTTM ?? metrics.epsAnnual;
  if (eps !== undefined) {
    if (eps < -1) {
      score -= 30;
      console.log(`[Quality] Severely negative EPS (${eps.toFixed(2)}) → -30`);
    } else if (eps < 0) {
      score -= 20;
      console.log(`[Quality] Negative EPS (${eps.toFixed(2)}) → -20`);
    } else if (eps > 5) {
      score += 15;
    } else if (eps > 2) {
      score += 10;
    } else if (eps > 0) {
      score += 5;
    }
  }

  // Profit margin
  const profitMargin = metrics.netProfitMarginTTM ?? metrics.netProfitMarginAnnual;
  if (profitMargin !== undefined) {
    if (profitMargin < -20) {
      score -= 20;
      console.log(`[Quality] Very negative profit margin (${profitMargin.toFixed(1)}%) → -20`);
    } else if (profitMargin < 0) {
      score -= 15;
      console.log(`[Quality] Negative profit margin (${profitMargin.toFixed(1)}%) → -15`);
    } else if (profitMargin > 20) {
      score += 15;
    } else if (profitMargin > 10) {
      score += 10;
    } else if (profitMargin > 5) {
      score += 5;
    }
  }

  // Operating margin
  const operatingMargin = metrics.operatingMarginTTM ?? metrics.operatingMarginAnnual;
  if (operatingMargin !== undefined) {
    if (operatingMargin < -10) {
      score -= 10;
      console.log(`[Quality] Negative operating margin (${operatingMargin.toFixed(1)}%) → -10`);
    } else if (operatingMargin > 25) {
      score += 10;
    } else if (operatingMargin > 15) {
      score += 5;
    }
  }

  // ROE
  const roe = metrics.roeTTM ?? metrics.roeAnnual;
  if (roe !== undefined) {
    if (roe < -10) {
      score -= 10;
      console.log(`[Quality] Negative ROE (${roe.toFixed(1)}%) → -10`);
    } else if (roe > 20) {
      score += 10;
    } else if (roe > 10) {
      score += 5;
    }
  }

  // P/E ratio
  const pe = metrics.peTTM ?? metrics.peAnnual;
  if (pe !== undefined) {
    if (pe < 0) {
      score -= 10;
      console.log(`[Quality] Negative P/E → -10`);
    } else if (pe > 100) {
      score -= 5;
    } else if (pe < 15 && pe > 0) {
      score += 5;
    }
  }

  // Market cap stability
  const marketCap = metrics.marketCapitalization;
  if (marketCap !== undefined) {
    if (marketCap > 200000)
      score += 5; // > $200B
    else if (marketCap > 10000)
      score += 3; // > $10B
    else if (marketCap < 2000) score -= 3; // < $2B
  }

  return Math.max(0, Math.min(100, score));
}

function calculateMomentumScore(
  quote: FinnhubQuote | null,
  metrics: FinnhubMetrics['metric'] | null
): number {
  if (!quote) return 50;

  let score = 50;

  // Position in 52-week range
  const currentPrice = quote.c;
  const high52 = metrics?.['52WeekHigh'];
  const low52 = metrics?.['52WeekLow'];

  if (high52 && low52 && high52 !== low52) {
    const range = high52 - low52;
    const position = (currentPrice - low52) / range;

    if (position > 0.9) score += 20;
    else if (position > 0.7) score += 15;
    else if (position > 0.5) score += 5;
    else if (position > 0.3) score -= 5;
    else if (position > 0.15) score -= 15;
    else score -= 20;

    console.log(
      `[Momentum] 52-week position: ${(position * 100).toFixed(0)}% (price: $${currentPrice}, range: $${low52}-$${high52})`
    );
  }

  // Daily change
  const changePercent = quote.dp;
  if (changePercent !== undefined) {
    if (changePercent > 5) score += 5;
    else if (changePercent < -5) score -= 5;
  }

  // Beta consideration
  const beta = metrics?.beta;
  if (beta !== undefined) {
    if (beta > 2.0) score -= 5;
    else if (beta < 0.5 && beta > 0) score += 3;
  }

  return Math.max(0, Math.min(100, score));
}

function calculateEarningsScoreWithHistory(
  metrics: FinnhubMetrics['metric'] | null,
  earnings: FinnhubEarnings[] | null
): number {
  let score = 50;

  // Part 1: Use metrics for growth rates
  if (metrics) {
    const revenueGrowth = metrics.revenueGrowthQuarterlyYoy ?? metrics.revenueGrowthTTMYoy;
    if (revenueGrowth !== undefined) {
      if (revenueGrowth > 30) {
        score += 10;
        console.log(`[Earnings] Strong revenue growth (${revenueGrowth.toFixed(1)}%) → +10`);
      } else if (revenueGrowth > 15) {
        score += 7;
      } else if (revenueGrowth > 5) {
        score += 3;
      } else if (revenueGrowth < -10) {
        score -= 10;
        console.log(`[Earnings] Revenue decline (${revenueGrowth.toFixed(1)}%) → -10`);
      } else if (revenueGrowth < 0) {
        score -= 5;
      }
    }

    const epsGrowth = metrics.epsGrowthQuarterlyYoy ?? metrics.epsGrowthTTMYoy;
    if (epsGrowth !== undefined) {
      if (epsGrowth > 25) {
        score += 10;
        console.log(`[Earnings] Strong EPS growth (${epsGrowth.toFixed(1)}%) → +10`);
      } else if (epsGrowth > 10) {
        score += 7;
      } else if (epsGrowth > 0) {
        score += 3;
      } else if (epsGrowth < -20) {
        score -= 15;
        console.log(`[Earnings] Severe EPS decline (${epsGrowth.toFixed(1)}%) → -15`);
      } else if (epsGrowth < -10) {
        score -= 10;
      } else if (epsGrowth < 0) {
        score -= 5;
      }
    }

    const eps = metrics.epsTTM ?? metrics.epsAnnual;
    if (eps !== undefined && eps < 0) {
      score -= 15;
      console.log(`[Earnings] Negative EPS (${eps.toFixed(2)}) → -15`);
    }
  }

  // Part 2: Use earnings history for beat/miss pattern
  if (earnings && earnings.length >= 2) {
    let beats = 0;
    let misses = 0;
    let negativeCount = 0;

    const recent = earnings.slice(0, 4); // Last 4 quarters

    recent.forEach(q => {
      if (q.actual > q.estimate) {
        beats++;
      } else if (q.actual < q.estimate) {
        misses++;
      }

      if (q.actual < 0) {
        negativeCount++;
      }
    });

    if (beats > misses) {
      const netBeats = beats - misses;
      score += netBeats * 5;
      console.log(`[Earnings] Beat pattern: ${beats} beats, ${misses} misses → +${netBeats * 5}`);
    } else if (misses > beats) {
      const netMisses = misses - beats;
      score -= netMisses * 5;
      console.log(`[Earnings] Miss pattern: ${beats} beats, ${misses} misses → -${netMisses * 5}`);
    }

    if (negativeCount >= 3) {
      score -= 15;
      console.log(`[Earnings] ${negativeCount}/4 quarters with negative EPS → -15`);
    } else if (negativeCount >= 2) {
      score -= 10;
      console.log(`[Earnings] ${negativeCount}/4 quarters with negative EPS → -10`);
    }
  }

  return Math.max(0, Math.min(100, score));
}

function calculateAnalystScore(recs: FinnhubRecommendation[] | null): {
  score: number;
  rating: AnalystRating | null;
} {
  if (!recs || recs.length === 0) {
    return { score: 50, rating: null };
  }

  const current = recs[0];
  const { strongBuy, buy, hold, sell, strongSell } = current;
  const total = strongBuy + buy + hold + sell + strongSell;

  if (total === 0) {
    return { score: 50, rating: null };
  }

  // Weighted average (5 = Strong Buy, 1 = Strong Sell)
  const weightedAvg = (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1) / total;
  const score = Math.round((weightedAvg - 1) * 25);

  let ratingLabel = 'Hold';
  if (weightedAvg >= 4.5) ratingLabel = 'Strong Buy';
  else if (weightedAvg >= 3.5) ratingLabel = 'Buy';
  else if (weightedAvg >= 2.5) ratingLabel = 'Hold';
  else if (weightedAvg >= 1.5) ratingLabel = 'Sell';
  else ratingLabel = 'Strong Sell';

  console.log(
    `[Analyst] ${ratingLabel} (${total} analysts: ${strongBuy} strong buy, ${buy} buy, ${hold} hold, ${sell} sell) → Score: ${score}`
  );

  return {
    score,
    rating: {
      rating: ratingLabel,
      strongBuy,
      buy,
      hold,
      sell,
      strongSell,
      targetMean: 0,
      targetHigh: 0,
      targetLow: 0,
    },
  };
}

// ============================================
// PUBLIC API
// ============================================

export async function getStockData(ticker: string): Promise<StockData | null> {
  console.log(`[Edge API] Fetching comprehensive data for ${ticker}...`);

  const symbol = ticker.toUpperCase();

  try {
    // Fetch all data in parallel through Edge Function
    const [quote, metricsData, recommendations, earnings, news] = await Promise.all([
      fetchFromEdge<FinnhubQuote>(symbol, 'quote', `quote-${symbol}`),
      fetchFromEdge<FinnhubMetrics>(symbol, 'metrics', `metrics-${symbol}`),
      fetchFromEdge<FinnhubRecommendation[]>(symbol, 'recommendations', `recs-${symbol}`),
      fetchFromEdge<FinnhubEarnings[]>(symbol, 'earnings', `earnings-${symbol}`),
      fetchFromEdge<FinnhubNews[]>(symbol, 'news', `news-${symbol}`),
    ]);

    if (!quote || quote.c === 0) {
      console.warn(`[Edge API] No quote data for ${ticker}`);
      return null;
    }

    const metrics = metricsData?.metric || null;

    // Convert arrays to proper format if they're objects (happens with cached JSONB data)
    let earningsArray: FinnhubEarnings[] | null = earnings;
    if (earnings && !Array.isArray(earnings)) {
      earningsArray = Object.values(earnings);
    }

    let recommendationsArray: FinnhubRecommendation[] | null = recommendations;
    if (recommendations && !Array.isArray(recommendations)) {
      recommendationsArray = Object.values(recommendations);
    }

    // Calculate all scores
    const qualityScore = calculateQualityScore(metrics);
    const momentumScore = calculateMomentumScore(quote, metrics);
    const earningsScore = calculateEarningsScoreWithHistory(metrics, earningsArray);
    const { score: analystScore, rating: analystRating } =
      calculateAnalystScore(recommendationsArray);

    // Convert earnings to quarterlyEPS format
    const quarterlyEPS: QuarterlyFinancials[] = (earningsArray || []).slice(0, 8).map(e => ({
      date: e.period,
      period: `Q${e.quarter}`,
      fiscalYear: String(e.year),
      eps: e.actual,
      revenue: 0,
      netMargin: 0,
    }));

    // Process Finnhub news with strict headline-based filtering
    // Finnhub returns 250+ items; we only keep ones that mention the company by name
    let newsArray: FinnhubNews[] | null = news;
    if (news && !Array.isArray(news)) {
      newsArray = Object.values(news);
    }

    const recentNews: NewsItem[] = [];
    if (newsArray && newsArray.length > 0) {
      console.log(`[Stock API] ${symbol} - Received ${newsArray.length} news items from Finnhub`);

      // Company name/ticker terms to match in headlines
      const COMPANY_NAMES: Record<string, string[]> = {
        NVDA: ['nvidia'],
        MSFT: ['microsoft'],
        AAPL: ['apple'],
        GOOGL: ['google', 'alphabet'],
        GOOG: ['google', 'alphabet'],
        AMZN: ['amazon'],
        META: ['meta platforms', 'meta ai', 'facebook', 'instagram', 'whatsapp', 'zuckerberg'],
        TSLA: ['tesla'],
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
        SHOP: ['shopify'],
        COIN: ['coinbase'],
        PYPL: ['paypal'],
        DIS: ['disney'],
        JPM: ['jpmorgan', 'jp morgan'],
        WMT: ['walmart'],
        COST: ['costco'],
        V: ['visa'],
        MA: ['mastercard'],
        JNJ: ['johnson & johnson'],
        PFE: ['pfizer'],
        UNH: ['unitedhealth'],
        XOM: ['exxon'],
        CVX: ['chevron'],
        HD: ['home depot'],
        BAC: ['bank of america'],
        SQ: ['block inc'],
        PINS: ['pinterest'],
        SNAP: ['snap inc', 'snapchat'],
      };

      const searchTerms = [symbol.toLowerCase()];
      if (COMPANY_NAMES[symbol]) {
        searchTerms.push(...COMPANY_NAMES[symbol]);
      }

      // Filter: headline MUST mention the company name or ticker
      const relevant = newsArray.filter(n => {
        if (!n.headline) return false;
        const headline = n.headline.toLowerCase();
        return searchTerms.some(term => headline.includes(term));
      });

      console.log(
        `[Stock API] ${symbol} - ${relevant.length} headlines mention the company (from ${newsArray.length} total)`
      );

      // Take the 3 most recent relevant headlines
      recentNews.push(
        ...relevant.slice(0, 3).map(n => ({
          headline: n.headline,
          source: n.source,
          datetime: n.datetime,
          url: n.url,
        }))
      );
    }
    console.log(`[Stock API] ${symbol} - Displaying ${recentNews.length} news items on card`);

    const result: StockData = {
      ticker: symbol,
      name: symbol, // Edge Function doesn't fetch profile, use ticker as name
      currentPrice: quote.c,
      change: quote.d,
      changePercent: quote.dp,
      volume: quote.v || 0, // Trading volume for liquidity analysis
      marketCap: (metrics?.marketCapitalization || 0) * 1e6,
      peRatio: metrics?.peTTM ?? metrics?.peAnnual ?? null,
      eps: metrics?.epsTTM ?? metrics?.epsAnnual ?? null,
      roe: metrics?.roeTTM ?? metrics?.roeAnnual ?? null,
      profitMargin: metrics?.netProfitMarginTTM ?? metrics?.netProfitMarginAnnual ?? null,
      operatingMargin: metrics?.operatingMarginTTM ?? metrics?.operatingMarginAnnual ?? null,
      fiftyTwoWeekHigh: metrics?.['52WeekHigh'] || 0,
      fiftyTwoWeekLow: metrics?.['52WeekLow'] || 0,
      beta: metrics?.beta ?? null,
      sector: 'Unknown', // Edge Function doesn't fetch profile
      qualityScore,
      momentumScore,
      earningsScore,
      analystScore,
      quarterlyEPS,
      analystRating,
      recentNews,
    };

    console.log(
      `[Edge API] ${ticker}: quality=${qualityScore}, momentum=${momentumScore}, earnings=${earningsScore}, analyst=${analystScore}`
    );
    console.log(
      `[Edge API] ${ticker} metrics: eps=${result.eps}, peRatio=${result.peRatio}, roe=${result.roe}, profitMargin=${result.profitMargin}, operatingMargin=${result.operatingMargin}`
    );

    return result;
  } catch (error) {
    console.error(`[Edge API] Failed to fetch data for ${ticker}:`, error);
    return null;
  }
}

export async function fetchMultipleStocks(
  tickers: string[],
  onProgress?: (completed: number, total: number, current: string) => void
): Promise<Map<string, StockData>> {
  const results = new Map<string, StockData>();

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    onProgress?.(i, tickers.length, ticker);

    try {
      const data = await getStockData(ticker);
      if (data) {
        results.set(ticker, data);
      }
    } catch (error) {
      console.error(`[Edge API] Failed to fetch ${ticker}:`, error);
    }

    onProgress?.(i + 1, tickers.length, ticker);
  }

  return results;
}

export function clearCache(): void {
  cache.clear();
  console.log('[Edge API] Cache cleared');
}
