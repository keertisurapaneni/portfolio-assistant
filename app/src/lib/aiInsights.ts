/**
 * AI-powered insights using lightweight LLM
 * Enhances rule-based scores with contextual analysis
 */

import type { Stock, RiskProfile } from '../types';

export interface AIInsight {
  summary: string; // 1-2 sentence contextual summary
  buyPriority: 'BUY' | 'SELL' | null; // Binary trade decision
  reasoning: string; // Metric-based rationale
  dataCompleteness: 'FULL' | 'SCORES_ONLY' | 'MINIMAL'; // How much data we have
  missingData?: string[]; // What data would improve the recommendation
  liquidityRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | null; // Liquidity/volume warning
  liquidityWarning?: string; // Specific warning message
  industryContext?: string; // Industry-specific perspective
  riskFactors?: string[]; // Key risks to watch
  opportunities?: string[]; // Why this might be attractive
  cached: boolean;
  timestamp: string;
}

// Bump PROMPT_VERSION whenever the AI prompt changes to invalidate stale cache
const PROMPT_VERSION = 8;
const CACHE_KEY_PREFIX = `ai-insight-v${PROMPT_VERSION}-`;
const CACHE_DURATION = 1000 * 60 * 60 * 4; // 4 hours (refresh more often during trading day)

/**
 * Get cached insight if available and fresh
 */
function getCachedInsight(ticker: string): AIInsight | null {
  try {
    const cached = localStorage.getItem(`${CACHE_KEY_PREFIX}${ticker}`);
    if (!cached) return null;

    const insight = JSON.parse(cached) as AIInsight;
    const age = Date.now() - new Date(insight.timestamp).getTime();

    if (age < CACHE_DURATION) {
      return { ...insight, cached: true };
    }
  } catch {
    // Invalid cache, ignore
  }
  return null;
}

/**
 * Save insight to cache
 */
function cacheInsight(ticker: string, insight: AIInsight): void {
  try {
    localStorage.setItem(`${CACHE_KEY_PREFIX}${ticker}`, JSON.stringify(insight));
  } catch {
    // Storage full, ignore
  }
}

/**
 * Calculate liquidity risk based on trading volume
 * Returns risk level and warning message
 */
function calculateLiquidityRisk(volume?: number): {
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  warning?: string;
} {
  if (!volume || volume === 0) {
    return { risk: null };
  }

  // Volume thresholds (daily shares traded)
  const LOW_VOLUME_THRESHOLD = 100_000; // < 100K shares = high risk
  const MEDIUM_VOLUME_THRESHOLD = 500_000; // < 500K shares = medium risk

  if (volume < LOW_VOLUME_THRESHOLD) {
    return {
      risk: 'HIGH',
      warning: `⚠️ LOW LIQUIDITY: Only ${(volume / 1000).toFixed(0)}K shares traded daily - May be hard to exit quickly`,
    };
  } else if (volume < MEDIUM_VOLUME_THRESHOLD) {
    return {
      risk: 'MEDIUM',
      warning: `⚠️ MODERATE LIQUIDITY: ${(volume / 1000).toFixed(0)}K shares traded daily - Exercise caution with large positions`,
    };
  }

  return { risk: 'LOW' }; // Healthy liquidity, no warning
}

// ─────────────────────────────────────────────────────────────────
// BATCH AI decisions — ONE Gemini call for ALL stocks at once
// ─────────────────────────────────────────────────────────────────

const CARD_CACHE_PREFIX = `ai-card-v${PROMPT_VERSION}-`;

export interface CardDecision {
  buyPriority: 'BUY' | 'SELL' | null;
  reasoning: string;
  timestamp: string;
}

function getCachedCardDecision(ticker: string): CardDecision | null {
  try {
    const raw = localStorage.getItem(`${CARD_CACHE_PREFIX}${ticker}`);
    if (!raw) return null;
    const d = JSON.parse(raw) as CardDecision;
    if (Date.now() - new Date(d.timestamp).getTime() < CACHE_DURATION) return d;
  } catch {
    /* */
  }
  return null;
}

function cacheCardDecision(ticker: string, d: CardDecision): void {
  try {
    localStorage.setItem(`${CARD_CACHE_PREFIX}${ticker}`, JSON.stringify(d));
  } catch {
    /* */
  }
}

/**
 * ONE Gemini call to analyze ALL stocks at once.
 * Returns a Map of ticker → CardDecision.
 * Cached per-stock so only uncached stocks go to Gemini.
 */
export async function getAICardDecisions(
  stocks: Array<{
    stock: Stock;
    qualityScore: number;
    earningsScore: number;
    momentumScore: number;
    analystScore: number;
    portfolioWeight?: number;
    avgCost?: number;
  }>,
  riskProfile: RiskProfile = 'moderate'
): Promise<Map<string, CardDecision>> {
  const results = new Map<string, CardDecision>();

  // Check cache first — only send uncached stocks to Gemini
  const uncached: typeof stocks = [];
  for (const s of stocks) {
    const cached = getCachedCardDecision(s.stock.ticker);
    if (cached) {
      results.set(s.stock.ticker, cached);
    } else {
      uncached.push(s);
    }
  }

  if (uncached.length === 0) {
    console.log('[AI Cards] All stocks cached, skipping Gemini call');
    return results;
  }

  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.warn('[AI Cards] No Gemini API key');
    return results;
  }

  // Build compact data for each uncached stock
  const stockLines = uncached
    .map(
      ({
        stock,
        qualityScore,
        earningsScore,
        momentumScore,
        analystScore,
        portfolioWeight,
        avgCost,
      }) => {
        const changePct = stock.priceChangePercent ?? 0;
        const changeStr =
          changePct !== 0 ? `${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%` : 'flat';
        const priceStr = stock.currentPrice ? `$${stock.currentPrice.toFixed(2)}` : '?';
        const high52 = stock.fiftyTwoWeekHigh ?? 0;
        const offHigh =
          high52 > 0 && stock.currentPrice
            ? `${(((high52 - stock.currentPrice) / high52) * 100).toFixed(0)}% off 52w high`
            : '';
        const posStr = portfolioWeight ? `${portfolioWeight.toFixed(1)}% of portfolio` : '';
        const plStr =
          avgCost && stock.currentPrice
            ? `P/L: ${(((stock.currentPrice - avgCost) / avgCost) * 100).toFixed(1)}%`
            : '';
        const newsStr =
          (stock.recentNews ?? [])
            .slice(0, 2)
            .map(n => n.headline)
            .join(' | ') || 'No news';
        const avgScore = ((qualityScore + earningsScore + momentumScore) / 3).toFixed(0);

        return `${stock.ticker}: ${priceStr} (${changeStr}) ${offHigh} | Q:${qualityScore} E:${earningsScore} M:${momentumScore} A:${analystScore} avg:${avgScore} | ${posStr} ${plStr} | News: ${newsStr}`;
      }
    )
    .join('\n');

  const prompt = `You are my portfolio analyst. I'm showing you ${uncached.length} stocks. For EACH one, decide: BUY, SELL, or null.

BE SELECTIVE. A good analyst doesn't say "buy everything." Out of ${uncached.length} stocks, probably only 2-5 deserve a BUY or SELL today. The rest are null — good companies doing nothing special right now.

WHEN TO SAY BUY (only when there's a clear reason TODAY):
- Earnings dip: GOOGL dropped 4% post-earnings, but 86% analysts rate it buy + AI infrastructure leader → BUY the overreaction
- Deep value: Stock 20%+ off highs while fundamentals are strong and revenue growing → market is mispricing, BUY
- Sector catalyst: NVDA is the AI computing leader with massive demand → BUY on any weakness
- Fear-based dip: quality stock down 4%+ on broad market sell-off, no company-specific bad news → BUY

WHEN TO SAY SELL:
- Broken thesis: missed earnings AND cut guidance → SELL
- Stop-loss: down 8%+ from entry with weak momentum → SELL

WHEN TO SAY null (THE MOST COMMON ANSWER):
- Stock is up or down 1-2% — that's normal noise, not a signal
- Great company trading normally — the conviction score already shows quality
- Stock is flat, no news, no catalyst — nothing to do
- Stock moved but for no clear reason — don't guess, say null

CRITICAL: If a stock is just "a good company" with no specific catalyst today, the answer is null. Being a good company is NOT a reason to BUY — the conviction score already captures that. BUY means "act NOW because something specific happened."

Risk profile: ${riskProfile}

MY PORTFOLIO:
${stockLines}

Return a JSON array with one object per stock, in the SAME order. No markdown, no backticks:
[{"ticker":"AAPL","buyPriority":"BUY","reasoning":"1 sentence about what happened today"},{"ticker":"MSFT","buyPriority":null,"reasoning":"1 sentence"},...]`;

  try {
    console.log(`[AI Cards] Sending ${uncached.length} stocks to Gemini...`);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      }
    );

    if (!response.ok) throw new Error(`Gemini API ${response.status}`);

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const jsonStr = text
      .replace(/```json?\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as Array<{
      ticker: string;
      buyPriority: 'BUY' | 'SELL' | null;
      reasoning: string;
    }>;

    console.log(`[AI Cards] Got ${parsed.length} decisions from Gemini`);

    const now = new Date().toISOString();
    for (const item of parsed) {
      if (!item.ticker) continue;
      const decision: CardDecision = {
        buyPriority: item.buyPriority ?? null,
        reasoning: item.reasoning ?? 'No reasoning.',
        timestamp: now,
      };
      results.set(item.ticker, decision);
      cacheCardDecision(item.ticker, decision);
    }
  } catch (err) {
    console.error('[AI Cards] Batch Gemini call failed:', err);
  }

  return results;
}

/**
 * Generate AI insights for a stock using Google Gemini (FREE)
 * Gemini 1.5 Flash: 1,500 requests/day free tier
 */
export async function generateAIInsights(
  stock: Stock,
  qualityScore: number,
  earningsScore: number,
  analystScore: number,
  momentumScore: number,
  portfolioWeight?: number,
  shares?: number,
  avgCost?: number,
  priceChangePercent?: number,
  analystRating?: Stock['analystRating'],
  riskProfile?: RiskProfile,
  volume?: number,
  recentNews?: Stock['recentNews']
): Promise<AIInsight | null> {
  // Check cache first
  const cached = getCachedInsight(stock.ticker);
  if (cached) {
    console.log(`[AI Insights] Using cached insights for ${stock.ticker}`);
    return cached;
  }

  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

  // Calculate liquidity risk
  const liquidity = calculateLiquidityRisk(volume);

  // If no API key, fall back to rule-based insights
  if (!GEMINI_API_KEY) {
    console.log(`[AI Insights] No Gemini API key, using rule-based insights`);
    const ruleBased = generateRuleBased(
      qualityScore,
      earningsScore,
      momentumScore,
      portfolioWeight,
      shares,
      avgCost,
      priceChangePercent,
      stock.currentPrice,
      riskProfile
    );
    const insight: AIInsight = {
      summary: generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: ruleBased.buyPriority,
      reasoning: ruleBased.reasoning,
      dataCompleteness: ruleBased.dataCompleteness,
      missingData: ruleBased.missingData,
      liquidityRisk: liquidity.risk,
      liquidityWarning: liquidity.warning,
      industryContext: generateIndustryContext(stock),
      cached: false,
      timestamp: new Date().toISOString(),
    };
    cacheInsight(stock.ticker, insight);
    return insight;
  }

  try {
    console.log(`[AI Insights] Generating AI insights for ${stock.ticker}...`);

    // Build context for LLM
    const metrics = [];
    if (stock.eps !== null && stock.eps !== undefined)
      metrics.push(`EPS: $${stock.eps.toFixed(2)}`);
    if (stock.peRatio !== null && stock.peRatio !== undefined)
      metrics.push(`P/E: ${stock.peRatio.toFixed(1)}`);
    if (stock.roe !== null && stock.roe !== undefined)
      metrics.push(`ROE: ${stock.roe.toFixed(1)}%`);
    if (stock.profitMargin !== null && stock.profitMargin !== undefined)
      metrics.push(`Profit Margin: ${stock.profitMargin.toFixed(1)}%`);
    if (stock.operatingMargin !== null && stock.operatingMargin !== undefined)
      metrics.push(`Operating Margin: ${stock.operatingMargin.toFixed(1)}%`);

    const positionContext =
      portfolioWeight !== undefined && portfolioWeight !== null
        ? portfolioWeight === 0
          ? 'No current position (0%)'
          : portfolioWeight < 5
            ? `Small position (${portfolioWeight.toFixed(1)}%)`
            : portfolioWeight < 15
              ? `Meaningful position (${portfolioWeight.toFixed(1)}%)`
              : portfolioWeight < 25
                ? `Large position (${portfolioWeight.toFixed(1)}%)`
                : `Very large position (${portfolioWeight.toFixed(1)}%)`
        : 'Position unknown';

    const hasPositionData = shares !== undefined && shares > 0;

    // 52-week range context
    let rangeContext = '';
    const high52 = stock.fiftyTwoWeekHigh ?? 0;
    const low52 = stock.fiftyTwoWeekLow ?? 0;
    const curPrice = stock.currentPrice ?? 0;
    if (high52 > 0 && low52 > 0 && curPrice > 0) {
      const range = high52 - low52;
      const positionInRange = range > 0 ? ((curPrice - low52) / range) * 100 : 50;
      const offHigh = ((high52 - curPrice) / high52) * 100;

      if (offHigh >= 20) {
        rangeContext = `\n🔥 DIP ALERT: Trading ${offHigh.toFixed(1)}% below 52-week high ($${high52.toFixed(2)}). Near bottom of range (${positionInRange.toFixed(0)}th percentile). 52W Low: $${low52.toFixed(2)}`;
      } else if (offHigh >= 10) {
        rangeContext = `\n📉 PULLBACK: ${offHigh.toFixed(1)}% off 52-week high ($${high52.toFixed(2)}). In lower half of range (${positionInRange.toFixed(0)}th percentile). 52W Low: $${low52.toFixed(2)}`;
      } else if (positionInRange >= 90) {
        rangeContext = `\n📈 NEAR HIGHS: Only ${offHigh.toFixed(1)}% from 52-week high ($${high52.toFixed(2)}). Trading at top of range.`;
      } else {
        rangeContext = `\n52W Range: $${low52.toFixed(2)} - $${high52.toFixed(2)} (currently ${positionInRange.toFixed(0)}th percentile)`;
      }
    }

    // Price change context for buy-the-dip opportunities
    const priceChangeText =
      priceChangePercent !== undefined
        ? priceChangePercent < 0
          ? `📉 DOWN ${Math.abs(priceChangePercent).toFixed(2)}% today ${priceChangePercent <= -5 ? '(SIGNIFICANT DIP!)' : priceChangePercent <= -3 ? '(Notable dip)' : ''}`
          : `📈 UP ${priceChangePercent.toFixed(2)}% today`
        : '[Price change unavailable]';

    // Calculate gain/loss from purchase price for trading rules
    let gainLossContext = '';
    if (avgCost && stock.currentPrice && avgCost > 0) {
      const gainLossPct = ((stock.currentPrice - avgCost) / avgCost) * 100;
      const gainLossAbs = stock.currentPrice - avgCost;

      if (gainLossPct <= -7) {
        gainLossContext = `\n⚠️ STOP-LOSS ALERT: Down ${Math.abs(gainLossPct).toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - 7% rule (or 3-4% in volatile markets)`;
      } else if (gainLossPct <= -3 && momentumScore < 40) {
        gainLossContext = `\n⚠️ VOLATILE MARKET: Down ${Math.abs(gainLossPct).toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) + weak momentum (${momentumScore}) - Tighten stops?`;
      } else if (gainLossPct >= 20) {
        gainLossContext = `\n💰 PROFIT-TAKING ZONE: Up ${gainLossPct.toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - 20-25% rule applies`;
      } else if (gainLossPct >= 10 && momentumScore >= 80) {
        gainLossContext = `\n🚀 RAPID GAINS: Up ${gainLossPct.toFixed(1)}%, momentum ${momentumScore} - Consider selling into strength (greed zone)`;
      } else if (gainLossPct < 0) {
        gainLossContext = `\nPosition P&L: ${gainLossPct.toFixed(1)}% (${gainLossAbs >= 0 ? '+' : ''}$${gainLossAbs.toFixed(2)})`;
      } else {
        gainLossContext = `\nPosition P&L: +${gainLossPct.toFixed(1)}% (+$${gainLossAbs.toFixed(2)})`;
      }
    }

    // Note on 2% Risk Rule (portfolio-level guidance)
    const riskRuleNote =
      portfolioWeight && portfolioWeight > 0
        ? `\n📊 RISK RULE: Position is ${portfolioWeight.toFixed(1)}% of portfolio. Never risk >2% of total capital on any single trade.`
        : '';

    // Build Wall Street analyst context
    let analystContext = '';
    if (analystRating) {
      const total =
        analystRating.strongBuy +
        analystRating.buy +
        analystRating.hold +
        analystRating.sell +
        analystRating.strongSell;
      const bullish = analystRating.strongBuy + analystRating.buy;
      const bearish = analystRating.sell + analystRating.strongSell;
      const bullishPct = total > 0 ? ((bullish / total) * 100).toFixed(0) : '0';
      const bearishPct = total > 0 ? ((bearish / total) * 100).toFixed(0) : '0';

      const upsidePct =
        stock.currentPrice && analystRating.targetMean > 0
          ? (((analystRating.targetMean - stock.currentPrice) / stock.currentPrice) * 100).toFixed(
              1
            )
          : null;

      analystContext = `
WALL STREET CONSENSUS (${total} analysts):
• Ratings: ${analystRating.strongBuy} Strong Buy, ${analystRating.buy} Buy, ${analystRating.hold} Hold, ${analystRating.sell} Sell, ${analystRating.strongSell} Strong Sell
• Sentiment: ${bullishPct}% Bullish, ${bearishPct}% Bearish
• Price Target: $${analystRating.targetMean.toFixed(2)} (Range: $${analystRating.targetLow.toFixed(2)} - $${analystRating.targetHigh.toFixed(2)})
${upsidePct ? `• Implied Upside: ${upsidePct}%` : ''}`;
    } else {
      analystContext = '\nWALL STREET CONSENSUS: [Not available]';
    }

    // Build recent news context (CRITICAL for context-aware decisions)
    let newsContext = '';
    if (recentNews && recentNews.length > 0) {
      const newsItems = recentNews
        .map((news, idx) => {
          const date = new Date(news.datetime * 1000);
          const hoursAgo = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60));
          const timeStr =
            hoursAgo < 1
              ? 'JUST NOW'
              : hoursAgo < 24
                ? `${hoursAgo}h ago`
                : `${Math.floor(hoursAgo / 24)}d ago`;
          const summary = news.summary ? ` — ${news.summary.substring(0, 120)}` : '';
          return `${idx + 1}. [${timeStr}] ${news.headline}${summary} (${news.source})`;
        })
        .join('\n');

      // Detect if earnings-related news is present
      const hasEarningsNews = recentNews.some(n => {
        const h = (n.headline || '').toLowerCase();
        return [
          'earnings',
          'results',
          'revenue',
          'quarter',
          'q1',
          'q2',
          'q3',
          'q4',
          'beat',
          'miss',
          'eps',
          'guidance',
          'capex',
        ].some(kw => h.includes(kw));
      });

      newsContext = `

RECENT NEWS & EVENTS:
${newsItems}
${
  hasEarningsNews
    ? `
🔴 EARNINGS NEWS DETECTED — This is the MOST important context for your analysis.
You MUST reference the earnings in your reasoning. Did they beat or miss? What was the market reaction? What does it mean for the stock going forward?`
    : `
⚠️ Analyze these headlines. They explain WHY the price moved. Connect the dots between news and price action in your reasoning.`
}`;
    } else {
      newsContext = '\n\nRECENT NEWS: [No recent news available - rely on metrics only]';
    }

    const prompt = `You manage my money. Your only job: tell me what to do with ${stock.ticker} TODAY. Not tomorrow, not long-term — TODAY.

Here's everything I know:

STOCK: ${stock.ticker} (${stock.name || stock.ticker})
POSITION: ${positionContext}${!hasPositionData ? " [I haven't imported my position data yet]" : ''}
TODAY: ${priceChangeText}${rangeContext}${gainLossContext}${riskRuleNote}
SCORES: Quality ${qualityScore}/100, Earnings ${earningsScore}/100, Momentum ${momentumScore}/100, Analysts ${analystScore}/100
FUNDAMENTALS: ${metrics.length > 0 ? metrics.join(', ') : '[Limited data]'}
${analystContext}${newsContext}

IMPORTANT CONTEXT:
I already have a conviction score that tells me this is a good or bad company long-term. I don't need you to repeat that. I need you to tell me: is there a reason to ACT today? 

Think like my personal analyst who makes me rich. Look at the news, the price move, the earnings. Connect the dots. Is today special or just another day?

- If there's an opportunity (dip on a great company, earnings beat but stock dropped, market panic) → BUY
- If there's danger (fundamentals broken, thesis changed, earnings disaster) → SELL  
- If it's just a normal day with no clear catalyst → null (most common answer — don't force it)

RESPOND WITH JSON ONLY (no markdown, no backticks):
{"buyPriority": "BUY" or "SELL" or null, "reasoning": "1-2 sentences about TODAY — what happened, why it matters, what I should do", "summary": "One-line company description"}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3, // Allow natural reasoning with news context
            maxOutputTokens: 500, // More space for context-rich explanations
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Try to parse JSON response
    let parsedResponse: {
      buyPriority?: string;
      reasoning?: string;
      summary?: string;
    } = {};

    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      }
    } catch {
      console.warn(`[AI Insights] Could not parse JSON, using fallback`);
    }

    // Get rule-based fallback for missing AI fields
    const ruleBased = generateRuleBased(
      qualityScore,
      earningsScore,
      momentumScore,
      portfolioWeight,
      shares,
      avgCost,
      priceChangePercent,
      stock.currentPrice,
      riskProfile
    );

    const insight: AIInsight = {
      summary:
        parsedResponse.summary ||
        generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: (parsedResponse.buyPriority as AIInsight['buyPriority']) || null,
      reasoning: parsedResponse.reasoning || ruleBased.reasoning,
      dataCompleteness: ruleBased.dataCompleteness,
      missingData: ruleBased.missingData,
      liquidityRisk: liquidity.risk,
      liquidityWarning: liquidity.warning,
      industryContext: undefined,
      cached: false,
      timestamp: new Date().toISOString(),
    };

    cacheInsight(stock.ticker, insight);
    console.log(
      `[AI Insights] Generated for ${stock.ticker}: ${insight.buyPriority || 'No recommendation'}`
    );
    return insight;
  } catch (error) {
    console.error(`[AI Insights] Failed for ${stock.ticker}:`, error);
    // Fallback to rule-based insights
    const ruleBased = generateRuleBased(
      qualityScore,
      earningsScore,
      momentumScore,
      portfolioWeight,
      shares,
      avgCost,
      priceChangePercent,
      stock.currentPrice,
      riskProfile,
      recentNews
    );
    const insight: AIInsight = {
      summary: generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: ruleBased.buyPriority,
      reasoning: ruleBased.reasoning,
      dataCompleteness: ruleBased.dataCompleteness,
      missingData: ruleBased.missingData,
      liquidityRisk: liquidity.risk,
      liquidityWarning: liquidity.warning,
      cached: false,
      timestamp: new Date().toISOString(),
    };
    cacheInsight(stock.ticker, insight);
    return insight;
  }
}

/**
 * Rule-based buy priority logic (fallback when no LLM)
 * Exported for use in main app to show priority on all stocks
 *
 * Risk profiles adjust thresholds:
 * - Aggressive: Lower stop-loss (3-4%), higher position limits (30%), more aggressive
 * - Moderate: Standard thresholds (7-8% stop, 25% position limit)
 * - Conservative: Tighter stop-loss (5-6%), lower position limits (20%), more cautious
 */
export function generateRuleBased(
  qualityScore: number,
  earningsScore: number,
  momentumScore: number,
  portfolioWeight?: number,
  shares?: number,
  avgCost?: number,
  priceChangePercent?: number,
  currentPrice?: number,
  riskProfile: RiskProfile = 'moderate',
  recentNews?: Array<{ headline: string; datetime: number }>,
  fiftyTwoWeekHigh?: number,
  _fiftyTwoWeekLow?: number
): {
  buyPriority: AIInsight['buyPriority'];
  reasoning: string;
  dataCompleteness: AIInsight['dataCompleteness'];
  missingData?: string[];
} {
  const position = portfolioWeight ?? 0;
  const hasPositionData = shares !== undefined && shares > 0;
  const hasCostData = avgCost !== undefined && avgCost > 0;
  const avgScore = (qualityScore + earningsScore + momentumScore) / 3;

  const guardrails = {
    aggressive: { stopLoss: -4, rebalanceAt: 30 },
    moderate: { stopLoss: -7, rebalanceAt: 25 },
    conservative: { stopLoss: -5, rebalanceAt: 20 },
  }[riskProfile];

  // Determine data completeness
  let dataCompleteness: AIInsight['dataCompleteness'] = 'FULL';
  const missingData: string[] = [];
  if (!hasPositionData) {
    dataCompleteness = 'SCORES_ONLY';
    missingData.push('Number of shares owned');
  }
  if (!hasCostData) {
    dataCompleteness = dataCompleteness === 'SCORES_ONLY' ? 'MINIMAL' : 'SCORES_ONLY';
    missingData.push('Average cost/purchase price');
  }

  // ─────────────────────────────────────────────────────────────────
  // Lightweight signals for the main card badge.
  // Only flag when something happened TODAY that demands attention.
  // Full AI reasoning runs when user taps the card.
  // ─────────────────────────────────────────────────────────────────

  // Helper: detect if today has earnings-related news
  const hasEarningsNews =
    recentNews?.some(n => {
      const h = n.headline?.toLowerCase() ?? '';
      return /earnings|beats|misses|revenue|guidance|eps|quarter|q[1-4]\b/.test(h);
    }) ?? false;

  // Helper: how far off 52-week high
  const offHighPct =
    fiftyTwoWeekHigh && fiftyTwoWeekHigh > 0 && currentPrice && currentPrice > 0
      ? ((fiftyTwoWeekHigh - currentPrice) / fiftyTwoWeekHigh) * 100
      : 0;

  const isDown = priceChangePercent !== undefined && priceChangePercent < 0;
  const dropPct = isDown ? Math.abs(priceChangePercent!) : 0;

  // ── SELL SIGNALS (mechanical guardrails) ──

  // Stop-loss triggered
  if (hasCostData && avgCost && avgCost > 0 && currentPrice && currentPrice > 0) {
    const gainLossPct = ((currentPrice - avgCost) / avgCost) * 100;
    if (gainLossPct <= guardrails.stopLoss) {
      return {
        buyPriority: 'SELL',
        reasoning: `Down ${Math.abs(gainLossPct).toFixed(1)}% from your $${avgCost.toFixed(2)} entry — stop-loss triggered.`,
        dataCompleteness,
        missingData,
      };
    }
  }

  // Overconcentration
  if (position > guardrails.rebalanceAt) {
    return {
      buyPriority: 'SELL',
      reasoning: `${position.toFixed(1)}% of portfolio — overconcentrated. Consider trimming.`,
      dataCompleteness,
      missingData,
    };
  }

  // Weak fundamentals (this stock has problems, not just a bad day)
  if (avgScore < 35 && momentumScore < 35) {
    return {
      buyPriority: 'SELL',
      reasoning: `Weak fundamentals and momentum — review if the thesis still holds.`,
      dataCompleteness,
      missingData,
    };
  }

  // ── BUY SIGNALS (today-specific catalysts only) ──

  // Earnings dip: stock dropped 4%+ today + earnings news = real overreaction
  if (hasEarningsNews && dropPct >= 4 && avgScore >= 55) {
    return {
      buyPriority: 'BUY',
      reasoning: `Down ${dropPct.toFixed(1)}% on earnings news — potential overreaction on solid company.`,
      dataCompleteness,
      missingData,
    };
  }

  // Panic drop: 5%+ daily drop on a decent company
  if (dropPct >= 5 && avgScore >= 50) {
    return {
      buyPriority: 'BUY',
      reasoning: `Down ${dropPct.toFixed(1)}% today — fear selling on a fundamentally sound stock.`,
      dataCompleteness,
      missingData,
    };
  }

  // Big dip: 3%+ daily drop on a quality company
  if (dropPct >= 3 && avgScore >= 60) {
    return {
      buyPriority: 'BUY',
      reasoning: `Quality company down ${dropPct.toFixed(1)}% today — buy the dip.`,
      dataCompleteness,
      missingData,
    };
  }

  // Deep value: quality stock 20%+ below 52-week high AND red today
  if (offHighPct >= 20 && isDown && avgScore >= 55) {
    return {
      buyPriority: 'BUY',
      reasoning: `${offHighPct.toFixed(0)}% below 52-week high and still falling — deep value zone.`,
      dataCompleteness,
      missingData,
    };
  }

  // ── NO SIGNAL (most stocks most days) ──
  let context = '';
  if (priceChangePercent !== undefined && Math.abs(priceChangePercent) >= 1) {
    context =
      priceChangePercent < 0
        ? `Down ${Math.abs(priceChangePercent).toFixed(1)}% today.`
        : `Up ${priceChangePercent.toFixed(1)}% today.`;
  }

  return {
    buyPriority: null,
    reasoning: context || 'No signal today — tap for AI analysis.',
    dataCompleteness,
    missingData,
  };
}

/**
 * Enhanced summary with industry awareness
 */
function generateEnhancedSummary(
  stock: Stock,
  qualityScore: number,
  earningsScore: number,
  analystScore: number
): string {
  // Detect industry patterns
  const isUnprofitable = qualityScore < 25;
  const hasGrowth = earningsScore >= 55;
  const wallStreetBullish = analystScore >= 65;

  if (isUnprofitable && hasGrowth && wallStreetBullish) {
    return `${stock.ticker} is a high-growth company still investing heavily in expansion. Wall Street is betting on future profitability as the business scales.`;
  } else if (!isUnprofitable && hasGrowth) {
    return `${stock.ticker} demonstrates strong profitability with solid growth. A balanced investment with good fundamentals.`;
  } else if (isUnprofitable && !wallStreetBullish) {
    return `${stock.ticker} shows concerning fundamentals with losses and weak sentiment. High risk without clear catalyst.`;
  } else {
    return `${stock.ticker} has mixed signals. Review detailed metrics to understand the investment thesis.`;
  }
}

/**
 * Industry-specific context
 */
function generateIndustryContext(_stock: Stock): string | undefined {
  // TODO: Map Finnhub sectors to industry insights
  // For now, return undefined - will be enhanced with LLM
  return undefined;
}

/**
 * Get LLM provider configuration
 */
export function getAIConfig() {
  return {
    enabled: false, // TODO: Enable when LLM integration is ready
    provider: 'openrouter', // or 'together', 'groq', 'openai'
    model: 'anthropic/claude-3-haiku', // Lightweight and fast
    maxTokens: 150,
    temperature: 0.3, // Low temperature for consistent financial analysis
  };
}
