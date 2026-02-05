/**
 * Stock API service using Finnhub
 * Free tier: 60 API calls/minute
 * Get your key at: https://finnhub.io/register
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const API_KEY = import.meta.env.VITE_FINNHUB_API_KEY || '';

// Cache to avoid redundant API calls
const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_DURATION = 1000 * 60 * 15; // 15 minutes

// Rate limiting (60 calls/min = 1 per second to be safe)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 200; // 200ms between requests

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

export interface StockData {
  ticker: string;
  name: string;
  currentPrice: number;
  change: number;
  changePercent: number;
  marketCap: number;
  peRatio: number | null;
  eps: number | null;
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
}

// ============================================
// FINNHUB RESPONSE TYPES
// ============================================

interface FinnhubQuote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Percent change
  h: number; // High
  l: number; // Low
  o: number; // Open
  pc: number; // Previous close
  t: number; // Timestamp
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
    currentRatioAnnual?: number;
    currentRatioQuarterly?: number;
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

interface FinnhubProfile {
  name: string;
  ticker: string;
  finnhubIndustry: string;
  marketCapitalization: number;
}

// ============================================
// API FUNCTIONS
// ============================================

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }

  lastRequestTime = Date.now();
  return fetch(url);
}

async function fetchFinnhub<T>(endpoint: string, cacheKey: string): Promise<T | null> {
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[Finnhub] Using cached data for ${cacheKey}`);
    return cached.data as T;
  }

  try {
    const url = `${FINNHUB_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}token=${API_KEY}`;
    console.log(`[Finnhub] Fetching: ${endpoint}`);

    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      console.error(`[Finnhub] HTTP error ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[Finnhub] API error:`, data.error);
      return null;
    }

    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data as T;
  } catch (error) {
    console.error(`[Finnhub] Fetch error:`, error);
    return null;
  }
}

// ============================================
// SCORE CALCULATION FUNCTIONS
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

  // Profit margin (Finnhub returns as percentage, e.g., 55.04 = 55.04%)
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

  // P/E ratio (penalize extremes)
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

  // Market cap stability (in millions from Finnhub)
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

  // Check for recent profitability FIRST (last 2-3 quarters)
  let recentlyProfitable = false;
  let persistentlyUnprofitable = false;
  
  if (earnings && earnings.length >= 2) {
    const lastTwoQuarters = earnings.slice(0, 2);
    
    // Company is "recently profitable" if last 2 quarters are positive
    recentlyProfitable = lastTwoQuarters.every(q => q.actual > 0);
    
    // Company is "persistently unprofitable" if 3+ of last 4 quarters are negative
    const negativeQuarters = earnings.slice(0, 4).filter(q => q.actual < 0).length;
    persistentlyUnprofitable = negativeQuarters >= 3;
    
    if (recentlyProfitable) {
      console.log(`[Earnings] Recently profitable: Last ${lastTwoQuarters.length} quarters positive`);
    }
  }

  // Part 1: Use metrics for growth rates
  if (metrics) {
    // Revenue growth
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

    // EPS growth from metrics
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

    // EPS positivity check - BUT don't penalize if recently turned profitable
    const eps = metrics.epsTTM ?? metrics.epsAnnual;
    if (eps !== undefined && eps < 0) {
      if (recentlyProfitable) {
        // Company turned profitable recently - lighter penalty or bonus
        score += 5;
        console.log(`[Earnings] TTM EPS negative (${eps.toFixed(2)}) but recently profitable → +5`);
      } else if (persistentlyUnprofitable) {
        // Still consistently losing money
        score -= 15;
        console.log(`[Earnings] Persistently negative EPS (${eps.toFixed(2)}) → -15`);
      } else {
        // Mixed results
        score -= 10;
        console.log(`[Earnings] Negative TTM EPS (${eps.toFixed(2)}) → -10`);
      }
    }
  }

  // Part 2: Use earnings history for beat/miss pattern
  if (earnings && earnings.length >= 2) {
    let beats = 0;
    let misses = 0;
    let negativeCount = 0;

    const recent = earnings.slice(0, 4); // Last 4 quarters

    recent.forEach(q => {
      // Beat/miss vs estimate
      if (q.actual > q.estimate) {
        beats++;
      } else if (q.actual < q.estimate) {
        misses++;
      }

      // Track negative EPS quarters
      if (q.actual < 0) {
        negativeCount++;
      }
    });

    // Beat/miss bonus
    if (beats > misses) {
      const netBeats = beats - misses;
      score += netBeats * 5;
      console.log(`[Earnings] Beat pattern: ${beats} beats, ${misses} misses → +${netBeats * 5}`);
    } else if (misses > beats) {
      const netMisses = misses - beats;
      score -= netMisses * 5;
      console.log(`[Earnings] Miss pattern: ${beats} beats, ${misses} misses → -${netMisses * 5}`);
    }

    // Persistent negative EPS penalty - ONLY if not recently profitable
    if (!recentlyProfitable) {
      if (negativeCount >= 3) {
        score -= 15;
        console.log(`[Earnings] ${negativeCount}/4 quarters with negative EPS → -15`);
      } else if (negativeCount >= 2) {
        score -= 10;
        console.log(`[Earnings] ${negativeCount}/4 quarters with negative EPS → -10`);
      }
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

  // Get most recent recommendation
  const current = recs[0];
  const { strongBuy, buy, hold, sell, strongSell } = current;
  const total = strongBuy + buy + hold + sell + strongSell;

  if (total === 0) {
    return { score: 50, rating: null };
  }

  // Weighted average (5 = Strong Buy, 1 = Strong Sell)
  const weightedAvg = (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1) / total;
  const score = Math.round((weightedAvg - 1) * 25);

  // Rating label
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
  console.log(`[Finnhub] Fetching comprehensive data for ${ticker}...`);

  const symbol = ticker.toUpperCase();

  try {
    // Fetch all data in parallel (Finnhub has generous rate limits)
    const [quote, metricsData, recommendations, profile, earnings] = await Promise.all([
      fetchFinnhub<FinnhubQuote>(`/quote?symbol=${symbol}`, `quote-${symbol}`),
      fetchFinnhub<FinnhubMetrics>(
        `/stock/metric?symbol=${symbol}&metric=all`,
        `metrics-${symbol}`
      ),
      fetchFinnhub<FinnhubRecommendation[]>(
        `/stock/recommendation?symbol=${symbol}`,
        `recs-${symbol}`
      ),
      fetchFinnhub<FinnhubProfile>(`/stock/profile2?symbol=${symbol}`, `profile-${symbol}`),
      fetchFinnhub<FinnhubEarnings[]>(`/stock/earnings?symbol=${symbol}`, `earnings-${symbol}`),
    ]);

    if (!quote || quote.c === 0) {
      console.warn(`[Finnhub] No quote data for ${ticker}`);
      return null;
    }

    const metrics = metricsData?.metric || null;

    // Calculate all scores (pass earnings for better earnings score)
    const qualityScore = calculateQualityScore(metrics);
    const momentumScore = calculateMomentumScore(quote, metrics);
    const earningsScore = calculateEarningsScoreWithHistory(metrics, earnings);
    const { score: analystScore, rating: analystRating } = calculateAnalystScore(recommendations);

    // Convert earnings to quarterlyEPS format
    const quarterlyEPS: QuarterlyFinancials[] = (earnings || [])
      .slice(0, 8) // Last 8 quarters
      .map(e => ({
        date: e.period,
        period: `Q${e.quarter}`,
        fiscalYear: String(e.year),
        eps: e.actual,
        revenue: 0, // Not provided by Finnhub earnings endpoint
        netMargin: 0,
      }));

    const result: StockData = {
      ticker: symbol,
      name: profile?.name || symbol,
      currentPrice: quote.c,
      change: quote.d,
      changePercent: quote.dp,
      marketCap: (profile?.marketCapitalization || metrics?.marketCapitalization || 0) * 1e6,
      peRatio: metrics?.peTTM ?? metrics?.peAnnual ?? null,
      eps: metrics?.epsTTM ?? metrics?.epsAnnual ?? null,
      fiftyTwoWeekHigh: metrics?.['52WeekHigh'] || 0,
      fiftyTwoWeekLow: metrics?.['52WeekLow'] || 0,
      beta: metrics?.beta ?? null,
      sector: profile?.finnhubIndustry || 'Unknown',
      qualityScore,
      momentumScore,
      earningsScore,
      analystScore,
      quarterlyEPS,
      analystRating,
    };

    console.log(
      `[Finnhub] ${ticker}: quality=${qualityScore}, momentum=${momentumScore}, earnings=${earningsScore}, analyst=${analystScore}, eps=${result.eps}, peRatio=${result.peRatio}`
    );

    return result;
  } catch (error) {
    console.error(`[Finnhub] Failed to fetch data for ${ticker}:`, error);
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
      console.error(`[Finnhub] Failed to fetch ${ticker}:`, error);
    }

    onProgress?.(i + 1, tickers.length, ticker);
  }

  return results;
}

export function clearCache(): void {
  cache.clear();
  console.log('[Finnhub] Cache cleared');
}
