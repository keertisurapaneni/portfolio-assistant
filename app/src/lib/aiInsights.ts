/**
 * AI-powered insights using lightweight LLM
 * Enhances rule-based scores with contextual analysis
 */

import type { Stock } from '../types';

export interface AIInsight {
  summary: string; // 1-2 sentence contextual summary
  buyPriority: 'BUY' | 'SELL' | null; // Binary trade decision
  reasoning: string; // Metric-based rationale
  dataCompleteness: 'FULL' | 'SCORES_ONLY' | 'MINIMAL'; // How much data we have
  missingData?: string[]; // What data would improve the recommendation
  industryContext?: string; // Industry-specific perspective
  riskFactors?: string[]; // Key risks to watch
  opportunities?: string[]; // Why this might be attractive
  cached: boolean;
  timestamp: string;
}

const CACHE_KEY_PREFIX = 'ai-insight-';
const CACHE_DURATION = 1000 * 60 * 60 * 24; // 24 hours

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
  analystRating?: Stock['analystRating']
): Promise<AIInsight | null> {
  // Check cache first
  const cached = getCachedInsight(stock.ticker);
  if (cached) {
    console.log(`[AI Insights] Using cached insights for ${stock.ticker}`);
    return cached;
  }

  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

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
      stock.currentPrice
    );
    const insight: AIInsight = {
      summary: generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: ruleBased.buyPriority,
      reasoning: ruleBased.reasoning,
      dataCompleteness: ruleBased.dataCompleteness,
      missingData: ruleBased.missingData,
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

    const avgScore = (qualityScore + earningsScore + momentumScore) / 3;
    const hasPositionData = shares !== undefined && shares > 0;

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
      const gainLossPct = (((stock.currentPrice - avgCost) / avgCost) * 100);
      const gainLossAbs = stock.currentPrice - avgCost;
      
      if (gainLossPct <= -7) {
        gainLossContext = `\n⚠️ STOP-LOSS ALERT: Down ${Math.abs(gainLossPct).toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - Consider 7% rule`;
      } else if (gainLossPct >= 20) {
        gainLossContext = `\n💰 PROFIT-TAKING ZONE: Up ${gainLossPct.toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - Consider 20-25% rule`;
      } else if (gainLossPct < 0) {
        gainLossContext = `\nPosition P&L: ${gainLossPct.toFixed(1)}% (${gainLossAbs >= 0 ? '+' : ''}$${gainLossAbs.toFixed(2)})`;
      } else {
        gainLossContext = `\nPosition P&L: +${gainLossPct.toFixed(1)}% (+$${gainLossAbs.toFixed(2)})`;
      }
    }

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

    const prompt = `You are Warren Buffett's quantitative analyst. Make BUY/SELL decisions for a long-term portfolio using provided metrics.

STOCK: ${stock.ticker} (${stock.name || stock.ticker})
POSITION: ${positionContext}${!hasPositionData ? ' [No position data - be conservative]' : ''}
PRICE TODAY: ${priceChangeText}${gainLossContext}

METRICS (0-100):
• Quality: ${qualityScore}/100 ${qualityScore >= 60 ? '✓' : qualityScore >= 40 ? '⚠' : '✗'}  |  Earnings: ${earningsScore}/100 ${earningsScore >= 60 ? '✓' : earningsScore >= 40 ? '⚠' : '✗'}
• Momentum: ${momentumScore}/100 ${momentumScore >= 60 ? '✓' : momentumScore >= 40 ? '⚠' : '✗'}  |  Analyst: ${analystScore}/100 ${analystScore >= 60 ? '✓' : analystScore >= 40 ? '⚠' : '✗'}
• COMPOSITE: ${avgScore.toFixed(0)}/100
• FUNDAMENTALS: ${metrics.length > 0 ? metrics.join(', ') : '[Limited]'}
${analystContext}

TRADING RULES TO APPLY:

1. **SELL Rules** (Risk Management & Profit-Taking):
   - 7-8% Stop-Loss: Cut losses immediately to protect capital
   - 20-25% Profit Target: Lock in gains at pre-set targets
   - Broken Fundamentals: Exit if financials weaken or competitive edge lost
   - Rebalance: Consider trimming if position exceeds 25% of portfolio
   - Tax Loss Harvesting: Use underperformers to offset capital gains
   
2. **BUY Rules** (Systematic Entry Points):
   - Market Dips: Buy strong companies during temporary downturns
   - Oversold Conditions: Look for RSI < 30 or technical oversold signals
   - Catalysts: Buy on analyst upgrades, product launches, strong earnings
   - Valuation: Prefer P/E < 20 for value, but accept higher for growth
   - Timing: Best opportunities in first 15-60 mins of trading day
   
3. **HOLD Rules** (Long-Term Compounding):
   - Never sell quality just because it hit new highs (let winners run)
   - Hold 1+ year for long-term capital gains tax benefits
   - Ignore short-term noise when fundamentals remain strong
   - Base decisions on strategy, not emotion

INVESTMENT PHILOSOPHY (Learn from these examples):

Example 1: META - Quality 78, Earnings 72, Momentum 55, Position 20%, Flat price
→ Decision: null (no badge)
→ Why: Exceptional quality company. Never sell winners just because position is large. Let compounders compound.

Example 2: GOOGL - Quality 72, Earnings 68, Momentum 50, Position 5%, DOWN 5.2%
→ Decision: "BUY"
→ Why: High-quality stock on sale. Down 5%+ is a gift. Position has room. Buy the dip.

Example 3: SNOW - Quality 35, Earnings 42, Momentum 38, Position 8%, Flat price
→ Decision: "SELL"
→ Why: Weak fundamentals across the board. Don't own mediocre companies. Exit cleanly.

Example 4: NVDA - Quality 82, Earnings 88, Momentum 75, Position 2%, UP 3%
→ Decision: "BUY"
→ Why: Exceptional quality, tiny position, strong momentum. Add aggressively despite run-up.

Example 5: AAPL - Quality 68, Earnings 55, Momentum 48, Position 12%, Flat price
→ Decision: null (no badge)
→ Why: Good company, appropriately sized. No catalyst to add or trim. Hold quietly.

Example 6: Weak Tech Stock - Quality 28, Earnings 35, Momentum 25, Position 6%, DOWN 8%
→ Decision: "SELL"
→ Why: Broken company. Don't catch falling knives. Price drop confirms weakness.

Example 7: Overconcentrated Mediocre Stock - Quality 52, Earnings 48, Momentum 42, Position 28%
→ Decision: "SELL"
→ Why: Mediocre fundamentals + overconcentrated (28% of portfolio). Rebalancing needed.

Example 8: Stock Down 8% from Purchase - Quality 55, Earnings 50, P&L: -8.2%
→ Decision: "SELL"
→ Why: Stop-loss triggered at -8%. Protect capital. Cut losses before they grow.

Example 9: Stock Up 23% from Purchase - Quality 60, Earnings 65, P&L: +23.1%
→ Decision: "SELL"
→ Why: Hit 20-25% profit target. Lock in gains. Can reassess entry later if needed.

KEY PRINCIPLES:
1. Risk Management First: 7-8% stop-loss and 20-25% profit-taking override other factors
2. Quality First: Never sell great companies (70+), trim mediocre ones (<50)
3. Buy Dips: Strong stocks down 3-5%+ = opportunity (if position <15%)
4. Position Sizing: Can own 20%+ of exceptional winners, but rebalance if >25% + not quality
5. Momentum Matters: Weak momentum (<40) + weak quality (<50) = avoid/exit
6. Be Selective: Most stocks → null. Only show BUY for top opportunities, SELL for real problems
7. Think Long-Term: Prefer holding 1+ year for tax benefits, but rules override emotions

YOUR TASK:
Analyze ${stock.ticker} using these principles. Think like the examples above.

Return JSON:
{
  "buyPriority": "BUY" | "SELL" | null,
  "reasoning": "One sentence citing specific metrics (e.g., 'Quality 72, Position 5%, down 5.2%')",
  "summary": "Brief company context"
}

Be decisive on clear opportunities/problems, silent on holds. ONLY valid JSON.`;

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
            temperature: 0.2, // Low but allow reasoning through examples
            maxOutputTokens: 300,
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
      stock.currentPrice
    );

    const insight: AIInsight = {
      summary:
        parsedResponse.summary ||
        generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: (parsedResponse.buyPriority as AIInsight['buyPriority']) || null,
      reasoning: parsedResponse.reasoning || ruleBased.reasoning,
      dataCompleteness: ruleBased.dataCompleteness,
      missingData: ruleBased.missingData,
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
      stock.currentPrice
    );
    const insight: AIInsight = {
      summary: generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: ruleBased.buyPriority,
      reasoning: ruleBased.reasoning,
      dataCompleteness: ruleBased.dataCompleteness,
      missingData: ruleBased.missingData,
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
 */
export function generateRuleBased(
  qualityScore: number,
  earningsScore: number,
  momentumScore: number,
  portfolioWeight?: number,
  shares?: number,
  avgCost?: number,
  priceChangePercent?: number,
  currentPrice?: number
): {
  buyPriority: AIInsight['buyPriority'];
  reasoning: string;
  dataCompleteness: AIInsight['dataCompleteness'];
  missingData?: string[];
} {
  const position = portfolioWeight ?? 0;
  const hasPositionData = shares !== undefined && shares > 0;
  const hasCostData = avgCost !== undefined && avgCost > 0;

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

  // If we don't have position data, apply simple quality-based logic
  if (!hasPositionData) {
    const avgScore = (qualityScore + earningsScore + momentumScore) / 3;

    // BUY: Exceptional quality (like Buffett finding great companies)
    if (avgScore >= 65 && momentumScore > 50) {
      return {
        buyPriority: 'BUY',
        reasoning: `Exceptional quality (avg ${avgScore.toFixed(0)}/100) - Quality ${qualityScore}, Earnings ${earningsScore}. Add position data for sizing.`,
        dataCompleteness,
        missingData,
      };
    }

    // SELL: Clearly broken (avoid mediocrity)
    if (avgScore < 45) {
      return {
        buyPriority: 'SELL',
        reasoning: `Weak fundamentals (avg ${avgScore.toFixed(0)}/100) - Quality ${qualityScore}, Earnings ${earningsScore}, Momentum ${momentumScore}.`,
        dataCompleteness,
        missingData,
      };
    }

    // Default: No badge (need position context)
    return {
      buyPriority: null,
      reasoning: `Avg ${avgScore.toFixed(0)}/100 - add position data for personalized decisions.`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle-based logic (inspired by Buffett)
  // "Be fearful when others are greedy, greedy when others are fearful"

  const avgScore = (qualityScore + earningsScore + momentumScore) / 3;
  const isQuality = avgScore >= 65; // Top tier
  const isStrong = avgScore >= 60; // Good company
  const isMediocre = avgScore >= 45 && avgScore < 60; // Meh
  const isWeak = avgScore < 45; // Problem

  const isDown3Plus = priceChangePercent !== undefined && priceChangePercent <= -3;
  const isDown5Plus = priceChangePercent !== undefined && priceChangePercent <= -5;

  // CRITICAL TRADING RULES: Apply 7% stop-loss and 20-25% profit-taking
  // These override other logic (risk management first!)
  if (hasCostData && avgCost && avgCost > 0 && currentPrice && currentPrice > 0) {
    const gainLossPct = ((currentPrice - avgCost) / avgCost) * 100;

    // Rule 1: 7-8% Stop-Loss Rule (protect capital)
    if (gainLossPct <= -7) {
      // Exception: Don't stop-loss on quality stocks during market-wide dips
      // (temporary market weakness vs fundamental problems)
      if (!(isQuality && momentumScore >= 40)) {
        return {
          buyPriority: 'SELL',
          reasoning: `Stop-loss triggered: Down ${Math.abs(gainLossPct).toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - 7% rule applies`,
          dataCompleteness,
          missingData,
        };
      }
    }

    // Rule 2: 20-25% Profit-Taking Rule (lock in gains)
    if (gainLossPct >= 20) {
      // Exception: Don't sell exceptional quality that's still strong
      // ("Let winners run" unless momentum deteriorating)
      if (!(isQuality && momentumScore >= 55)) {
        return {
          buyPriority: 'SELL',
          reasoning: `Profit-taking zone: Up ${gainLossPct.toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - 20-25% rule applies`,
          dataCompleteness,
          missingData,
        };
      }
    }
  }

  // Rebalancing Rule: Position too large (>25% of portfolio)
  // Only suggest trimming if it's not exceptional quality OR if it's becoming risky
  if (position > 25) {
    if (!isQuality || momentumScore < 45) {
      return {
        buyPriority: 'SELL',
        reasoning: `Overconcentrated position: ${position.toFixed(1)}% of portfolio. ${!isQuality ? 'Not exceptional quality - rebalance recommended' : 'Momentum weakening - consider trimming'}`,
        dataCompleteness,
        missingData,
      };
    }
    // For exceptional quality (65+) with strong momentum, just note it but don't force sell
  }

  // Principle 1: Buy quality on dips (best opportunities)
  if (isDown5Plus && isStrong && position < 12) {
    return {
      buyPriority: 'BUY',
      reasoning: `Quality on sale! Down ${Math.abs(priceChangePercent!).toFixed(1)}%, avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}% - Quality ${qualityScore}, Earnings ${earningsScore}`,
      dataCompleteness,
      missingData,
    };
  }

  if (isDown3Plus && isQuality && position < 15) {
    return {
      buyPriority: 'BUY',
      reasoning: `Exceptional quality dip! Down ${Math.abs(priceChangePercent!).toFixed(1)}%, avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}%`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle 2: Sell broken companies (avoid mediocrity)
  if (isWeak) {
    return {
      buyPriority: 'SELL',
      reasoning: `Weak fundamentals (avg ${avgScore.toFixed(0)}/100) - Quality ${qualityScore}, Earnings ${earningsScore}, Momentum ${momentumScore}`,
      dataCompleteness,
      missingData,
    };
  }

  if (momentumScore < 35 && isMediocre) {
    return {
      buyPriority: 'SELL',
      reasoning: `Deteriorating mediocre stock - Momentum ${momentumScore}, avg ${avgScore.toFixed(0)}/100`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle 3: Buy quality with room to grow position
  if (isStrong && position < 8 && momentumScore >= 45) {
    return {
      buyPriority: 'BUY',
      reasoning: `Strong company (avg ${avgScore.toFixed(0)}/100), small position ${position.toFixed(1)}% - Quality ${qualityScore}, Earnings ${earningsScore}`,
      dataCompleteness,
      missingData,
    };
  }

  if (isQuality && position < 15 && momentumScore >= 50) {
    return {
      buyPriority: 'BUY',
      reasoning: `Exceptional quality (avg ${avgScore.toFixed(0)}/100), position ${position.toFixed(1)}% has room`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle 4: Let winners run (no badge for good companies at size)
  // Most stocks land here - hold quietly
  return {
    buyPriority: null,
    reasoning: `Avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}% - no clear action`,
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
