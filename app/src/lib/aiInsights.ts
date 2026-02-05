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
          const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
          const timeStr = daysAgo === 0 ? 'TODAY' : daysAgo === 1 ? 'YESTERDAY' : `${daysAgo}d ago`;
          return `${idx + 1}. [${timeStr}] ${news.headline}\n   ${news.summary.substring(0, 150)}... (${news.source})`;
        })
        .join('\n');

      newsContext = `

RECENT NEWS & EVENTS (Last 7 days):
${newsItems}

⚠️ IMPORTANT: Analyze these news items carefully! They explain WHY the price moved.
- Earnings miss/beat? → Key buying/selling opportunity
- Major announcement? → Validates or breaks investment thesis
- Negative news + quality stock? → Potential "buy the dip"
- Positive news + weak stock? → Temporary bounce, stay cautious`;
    } else {
      newsContext = '\n\nRECENT NEWS: [No recent news available - rely on metrics only]';
    }

    const prompt = `You are an elite stock analyst whose clients rely on you to make them rich. Your reputation is built on spotting opportunities others miss and protecting capital when risks appear.

STOCK ANALYSIS REQUEST: ${stock.ticker} (${stock.name || stock.ticker})

THE DATA YOU HAVE:
• Current Position: ${positionContext}${!hasPositionData ? ' [No position data available]' : ''}
• Today's Price Action: ${priceChangeText}${gainLossContext}${riskRuleNote}

QUANTITATIVE SCORES (0-100 scale):
• Quality: ${qualityScore}/100 ${qualityScore >= 60 ? '✓' : qualityScore >= 40 ? '⚠' : '✗'} — Profitability, margins, financial health
• Earnings: ${earningsScore}/100 ${earningsScore >= 60 ? '✓' : earningsScore >= 40 ? '⚠' : '✗'} — EPS trend, beat/miss history
• Momentum: ${momentumScore}/100 ${momentumScore >= 60 ? '✓' : momentumScore >= 40 ? '⚠' : '✗'} — Price trend, 52-week position
• Analyst Consensus: ${analystScore}/100 ${analystScore >= 60 ? '✓' : analystScore >= 40 ? '⚠' : '✗'} — Wall Street ratings
• Fundamentals: ${metrics.length > 0 ? metrics.join(', ') : '[Limited data]'}
${analystContext}${newsContext}

YOUR MISSION:
Think like a stock analyst who wants to make clients wealthy. Look at the data above - the scores, the news, the price action, the position size. Is this a compelling BUY opportunity right now? A problem to SELL? Or just... nothing special (return null)?

YOUR STYLE:
- You're selective - most stocks get no signal (null). Only clear opportunities or problems get BUY/SELL.
- You connect dots - if there's news, explain how it relates to the opportunity/risk.
- You manage risk - big losses destroy wealth, so you respect stop-losses and position sizing.
- You love quality companies on sale - panic creates the best opportunities.
- You hate losing money - if fundamentals are broken or a stop-loss hits, you're out.

RESPOND WITH JSON ONLY:
{
  "buyPriority": "BUY" | "SELL" | null,
  "reasoning": "One clear sentence explaining your call using the news/data context",
  "summary": "Brief company overview"
}`;

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
  _recentNews?: Array<{ headline: string; datetime: number }> // News displayed separately in UI
): {
  buyPriority: AIInsight['buyPriority'];
  reasoning: string;
  dataCompleteness: AIInsight['dataCompleteness'];
  missingData?: string[];
} {
  const position = portfolioWeight ?? 0;
  const hasPositionData = shares !== undefined && shares > 0;
  const hasCostData = avgCost !== undefined && avgCost > 0;

  // Risk Profile Adjustments
  const riskThresholds = {
    aggressive: {
      stopLoss: -4, // More tolerant of volatility
      tightenedStop: -5, // Slightly tighter in volatile markets
      profitTarget: 25, // Higher profit target
      maxPosition: 30, // Can concentrate more
      rebalanceAt: 30, // Rebalance at 30%
    },
    moderate: {
      stopLoss: -7, // Standard stop-loss
      tightenedStop: -3, // Standard tightened
      profitTarget: 20, // Standard profit target
      maxPosition: 25, // Standard concentration
      rebalanceAt: 25, // Rebalance at 25%
    },
    conservative: {
      stopLoss: -5, // Tighter stop-loss
      tightenedStop: -3, // Same tightened (already conservative)
      profitTarget: 15, // Lower profit target (take profits sooner)
      maxPosition: 20, // Less concentration
      rebalanceAt: 20, // Rebalance earlier
    },
  };

  const thresholds = riskThresholds[riskProfile];

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
        reasoning: `Quality company. Import your holdings to see recommended position size.`,
        dataCompleteness,
        missingData,
      };
    }

    // SELL: Clearly broken (avoid mediocrity)
    if (avgScore < 45) {
      return {
        buyPriority: 'SELL',
        reasoning: `Weak fundamentals across quality, earnings, and momentum. Consider avoiding.`,
        dataCompleteness,
        missingData,
      };
    }

    // Default: No badge (need position context)
    return {
      buyPriority: null,
      reasoning: `Import portfolio for personalized buy/sell recommendations.`,
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

  // CRITICAL TRADING RULES: Apply stop-loss and profit-taking
  // These override other logic (risk management first!)
  if (hasCostData && avgCost && avgCost > 0 && currentPrice && currentPrice > 0) {
    const gainLossPct = ((currentPrice - avgCost) / avgCost) * 100;

    // Detect volatile/correcting market conditions (use momentum as proxy)
    const isVolatileMarket = momentumScore < 40;

    // Rule 1A: Tightened Stop-Loss in Volatile Markets (risk-profile adjusted)
    if (isVolatileMarket && gainLossPct <= thresholds.tightenedStop) {
      // In volatile markets, tighten stops for faster exits
      if (!isQuality || momentumScore < 35) {
        return {
          buyPriority: 'SELL',
          reasoning: `Down ${Math.abs(gainLossPct).toFixed(1)}% from your $${avgCost.toFixed(2)} entry - cut losses in volatile market.`,
          dataCompleteness,
          missingData,
        };
      }
    }

    // Rule 1B: Standard Stop-Loss (risk-profile adjusted: aggressive=-4%, moderate=-7%, conservative=-5%)
    if (gainLossPct <= thresholds.stopLoss) {
      // Exception: Don't stop-loss on quality stocks during market-wide dips
      // (temporary market weakness vs fundamental problems)
      if (!(isQuality && momentumScore >= 40)) {
        return {
          buyPriority: 'SELL',
          reasoning: `Down ${Math.abs(gainLossPct).toFixed(1)}% from your $${avgCost.toFixed(2)} entry - stop-loss triggered.`,
          dataCompleteness,
          missingData,
        };
      }
    }

    // Rule 2A: Sell Into Strength (Excessive Fast Gains = Maximum Greed)
    // If stock up 10-15%+ AND very high momentum (80+), likely euphoria - take profits fast
    if (gainLossPct >= 10 && momentumScore >= 80) {
      return {
        buyPriority: 'SELL',
        reasoning: `Up ${gainLossPct.toFixed(1)}% with extreme momentum - take profits before reversal.`,
        dataCompleteness,
        missingData,
      };
    }

    // Rule 2B: Profit-Taking Rule (risk-profile adjusted: aggressive=25%, moderate=20%, conservative=15%)
    if (gainLossPct >= thresholds.profitTarget) {
      // Exception: Don't sell exceptional quality that's still strong
      // ("Let winners run" unless momentum deteriorating)
      if (!(isQuality && momentumScore >= 55)) {
        return {
          buyPriority: 'SELL',
          reasoning: `Up ${gainLossPct.toFixed(1)}% from your $${avgCost.toFixed(2)} entry - profit target reached.`,
          dataCompleteness,
          missingData,
        };
      }
    }
  }

  // Rebalancing Rule: Position too large (risk-profile adjusted: aggressive=30%, moderate=25%, conservative=20%)
  // Only suggest trimming if it's not exceptional quality OR if it's becoming risky
  if (position > thresholds.rebalanceAt) {
    if (!isQuality || momentumScore < 45) {
      return {
        buyPriority: 'SELL',
        reasoning: `${position.toFixed(1)}% of portfolio - too concentrated. ${!isQuality ? 'Rebalance into better opportunities' : 'Trim to reduce risk'}.`,
        dataCompleteness,
        missingData,
      };
    }
    // For exceptional quality (65+) with strong momentum, just note it but don't force sell
  }

  // Principle 1: Buy During Maximum Fear (panic = opportunity)
  const isDown8Plus = priceChangePercent !== undefined && priceChangePercent <= -8;

  // Calculate buy position limits based on risk profile
  const buyPositionLimit = thresholds.maxPosition * 0.7; // Can buy up to 70% of max position

  // Maximum Fear: Quality stock down 8%+ = panic selling, aggressive buy
  if (isDown8Plus && isQuality && position < buyPositionLimit) {
    return {
      buyPriority: 'BUY',
      reasoning: `Big drop (${Math.abs(priceChangePercent!).toFixed(1)}%) on quality company - buy the panic. You own ${position.toFixed(1)}%.`,
      dataCompleteness,
      missingData,
    };
  }

  // Quality on sale during dips (use 40% of max as threshold)
  const dipBuyLimit = thresholds.maxPosition * 0.4;
  if (isDown5Plus && isStrong && position < dipBuyLimit) {
    return {
      buyPriority: 'BUY',
      reasoning: `Quality company down ${Math.abs(priceChangePercent!).toFixed(1)}% - good entry point. You own ${position.toFixed(1)}%.`,
      dataCompleteness,
      missingData,
    };
  }

  // Exceptional quality dips (use 60% of max as threshold)
  const qualityDipLimit = thresholds.maxPosition * 0.6;
  if (isDown3Plus && isQuality && position < qualityDipLimit) {
    return {
      buyPriority: 'BUY',
      reasoning: `Strong fundamentals, down ${Math.abs(priceChangePercent!).toFixed(1)}%. Add to your ${position.toFixed(1)}% position.`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle 2: Sell broken companies (avoid mediocrity)
  if (isWeak) {
    return {
      buyPriority: 'SELL',
      reasoning: `Poor fundamentals across quality, earnings, and momentum. Consider selling.`,
      dataCompleteness,
      missingData,
    };
  }

  if (momentumScore < 35 && isMediocre) {
    return {
      buyPriority: 'SELL',
      reasoning: `Weak momentum on mediocre company. Consider trimming position.`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle 3: Buy quality with room to grow position (risk-profile adjusted)
  const smallPositionLimit = thresholds.maxPosition * 0.27; // Can buy if < 27% of max
  if (isStrong && position < smallPositionLimit && momentumScore >= 45) {
    return {
      buyPriority: 'BUY',
      reasoning: `Solid company with room to grow your ${position.toFixed(1)}% position.`,
      dataCompleteness,
      missingData,
    };
  }

  const qualityPositionLimit = thresholds.maxPosition * 0.5; // Can buy if < 50% of max
  if (isQuality && position < qualityPositionLimit && momentumScore >= 50) {
    return {
      buyPriority: 'BUY',
      reasoning: `High-quality company - consider adding to your ${position.toFixed(1)}% position.`,
      dataCompleteness,
      missingData,
    };
  }

  // Principle 4: Let winners run (no badge for good companies at size)
  // Most stocks land here - hold quietly
  return {
    buyPriority: null,
    reasoning: `Solid holding at ${position.toFixed(1)}% - no immediate action needed.`,
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
