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
function calculateLiquidityRisk(
  volume?: number
): { risk: 'LOW' | 'MEDIUM' | 'HIGH' | null; warning?: string } {
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
    const riskRuleNote = portfolioWeight && portfolioWeight > 0 
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
      const newsItems = recentNews.map((news, idx) => {
        const date = new Date(news.datetime * 1000);
        const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
        const timeStr = daysAgo === 0 ? 'TODAY' : daysAgo === 1 ? 'YESTERDAY' : `${daysAgo}d ago`;
        return `${idx + 1}. [${timeStr}] ${news.headline}\n   ${news.summary.substring(0, 150)}... (${news.source})`;
      }).join('\n');

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

    const prompt = `You are Warren Buffett's quantitative analyst. Make BUY/SELL decisions for a long-term portfolio using provided metrics.

STOCK: ${stock.ticker} (${stock.name || stock.ticker})
POSITION: ${positionContext}${!hasPositionData ? ' [No position data - be conservative]' : ''}
PRICE TODAY: ${priceChangeText}${gainLossContext}${riskRuleNote}

METRICS (0-100):
• Quality: ${qualityScore}/100 ${qualityScore >= 60 ? '✓' : qualityScore >= 40 ? '⚠' : '✗'}  |  Earnings: ${earningsScore}/100 ${earningsScore >= 60 ? '✓' : earningsScore >= 40 ? '⚠' : '✗'}
• Momentum: ${momentumScore}/100 ${momentumScore >= 60 ? '✓' : momentumScore >= 40 ? '⚠' : '✗'}  |  Analyst: ${analystScore}/100 ${analystScore >= 60 ? '✓' : analystScore >= 40 ? '⚠' : '✗'}
• COMPOSITE: ${avgScore.toFixed(0)}/100
• FUNDAMENTALS: ${metrics.length > 0 ? metrics.join(', ') : '[Limited]'}
${analystContext}${newsContext}

QUANTITATIVE TRADING RULES (Data-Driven, Remove Emotion):

1. **SELL Rules** (Strict Risk Management):
   - 7-8% Stop-Loss: Auto-sell if down 7-8% from purchase (protect capital)
   - 3-4% Tightened Stops: Use in volatile/correcting markets for faster exit
   - 2% Risk Rule: Never risk >2% of total portfolio on single position loss
   - 20-25% Profit Target: Lock gains at pre-set targets (remove greed)
   - Sell Into Strength: Exit during rapid, excessive gains (maximum greed)
   - Fundamental Decay: Exit when earnings/growth/competitive position deteriorates
   - Market Correction: Sell when broader market enters correction mode
   - Rebalance: Trim if position >25% of portfolio (unless exceptional quality)
   - Wash-Sale: Don't rebuy within 30 days after tax-loss sale
   
2. **BUY Rules** (Systematic Entry Points):
   - Maximum Fear: Buy quality during market panic/recession (buy low)
   - Breakout Point: Buy above resistance level with high volume confirmation
   - Market Dips: Buy quality down 3-5%+ during temporary weakness
   - P/E Comparison: Prefer P/E < industry average or < 20 for value
   - Analyst Upgrades: Buy on upward price target revisions
   - Oversold RSI: Look for RSI < 30 technical oversold signals
   - Volume Confirmation: Heavy first-hour volume establishes trend
   - Optimal Timing: First 15-60 mins after open (high volatility)
   - Optimal Months: April, Oct, Nov historically stronger for buying
   
3. **HOLD Rules** (Long-Term Compounding):
   - Never sell quality at new highs (let winners compound)
   - Hold 1+ year for long-term capital gains tax rates
   - 70/30 Allocation: Maintain ~70% equities, 30% bonds for balance
   - Ignore noise when fundamentals strong
   - Follow strategy, not emotion

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

Example 10: Stock Down 4% in Volatile Market - Quality 58, Earnings 62, Momentum 38 (declining)
→ Decision: "SELL"
→ Why: Market in correction, momentum deteriorating. Tighten stop to 3-4% in volatile conditions.

Example 11: Rapid 15% Gain in 3 Days - Quality 55, Earnings 60, Momentum 85
→ Decision: "SELL"
→ Why: Excessive fast-paced gains = maximum greed. Sell into strength, take profits quickly.

Example 12: Quality Stock During Market Panic - Quality 75, Earnings 70, DOWN 8% (market -5%)
→ Decision: "BUY"
→ Why: Maximum fear = opportunity. Exceptional quality on sale during broad market panic.

KEY PRINCIPLES (Quantitative, Data-Driven):
1. Risk Management First: 7-8% stop-loss (3-4% in volatile markets) and 20-25% profit-taking override all
2. 2% Risk Cap: Never risk >2% of total portfolio on any single position
3. Buy Fear, Sell Greed: Enter during panic, exit during euphoria or rapid gains
4. Quality + Math: Exceptional quality (70+) gets more leeway, but math rules apply
5. Volume = Confirmation: High volume on breakouts = valid signal
6. Market Context: Tighten stops in corrections, buy aggressively in maximum fear
7. Position Sizing: Can own 20%+ of winners, but rebalance if >25% + not exceptional
8. Momentum Matters: Weak momentum (<40) + weak quality (<50) = immediate exit
9. Be Selective: Most stocks → null. Only BUY top opportunities, SELL real problems
10. Systematic Approach: Follow rules, not emotions. Data beats gut feelings

YOUR TASK:
Analyze ${stock.ticker} using these principles AND the recent news/events above. Think like the examples.

**CRITICAL**: Your reasoning MUST explain WHY using news context:
- If there's an earnings report → Did they beat/miss? Is the drop/rally justified?
- If there's negative news → Is this a buying opportunity for a quality company?
- If there's no major news → Why is the stock moving? Just market noise?
- Position size matters → But don't buy just because position is small. Buy because of compelling VALUE/NEWS.

Examples of GOOD reasoning:
✅ "Dropped 7% after earnings miss, but quality strong (76/100). Overreaction = buy opportunity"
✅ "Up 15% on product launch hype, momentum 85. Take profits - maximum greed"
✅ "Weak earnings (45/100) + negative guidance news. Thesis broken - exit"
❌ "Exceptional quality (avg 76/100), position 14.0% has room" ← TOO MECHANICAL, NO CONTEXT!

Return JSON:
{
  "buyPriority": "BUY" | "SELL" | null,
  "reasoning": "ONE sentence with NEWS CONTEXT + metrics (e.g., 'Earnings miss but quality intact - buy the dip')",
  "summary": "Brief company context with news"
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
  riskProfile: RiskProfile = 'moderate'
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
          reasoning: `Tightened stop-loss (${riskProfile}, volatile): Down ${Math.abs(gainLossPct).toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - Momentum ${momentumScore}`,
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
          reasoning: `Stop-loss (${riskProfile}): Down ${Math.abs(gainLossPct).toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - ${Math.abs(thresholds.stopLoss)}% threshold`,
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
        reasoning: `Sell into strength: Up ${gainLossPct.toFixed(1)}% with extreme momentum (${momentumScore}) - Maximum greed, take profits fast`,
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
          reasoning: `Profit-taking (${riskProfile}): Up ${gainLossPct.toFixed(1)}% from purchase ($${avgCost.toFixed(2)}) - ${thresholds.profitTarget}% target hit`,
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
        reasoning: `Overconcentrated (${riskProfile}): ${position.toFixed(1)}% of portfolio (>${thresholds.rebalanceAt}%). ${!isQuality ? 'Not exceptional quality - rebalance' : 'Momentum weakening - trim'}`,
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
      reasoning: `MAXIMUM FEAR (${riskProfile})! Quality stock down ${Math.abs(priceChangePercent!).toFixed(1)}% - Panic = opportunity. Avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}%`,
      dataCompleteness,
      missingData,
    };
  }

  // Quality on sale during dips (use 40% of max as threshold)
  const dipBuyLimit = thresholds.maxPosition * 0.4;
  if (isDown5Plus && isStrong && position < dipBuyLimit) {
    return {
      buyPriority: 'BUY',
      reasoning: `Quality on sale (${riskProfile})! Down ${Math.abs(priceChangePercent!).toFixed(1)}%, avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}% - Quality ${qualityScore}, Earnings ${earningsScore}`,
      dataCompleteness,
      missingData,
    };
  }

  // Exceptional quality dips (use 60% of max as threshold)
  const qualityDipLimit = thresholds.maxPosition * 0.6;
  if (isDown3Plus && isQuality && position < qualityDipLimit) {
    return {
      buyPriority: 'BUY',
      reasoning: `Exceptional quality dip (${riskProfile})! Down ${Math.abs(priceChangePercent!).toFixed(1)}%, avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}%`,
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

  // Principle 3: Buy quality with room to grow position (risk-profile adjusted)
  const smallPositionLimit = thresholds.maxPosition * 0.27; // Can buy if < 27% of max
  if (isStrong && position < smallPositionLimit && momentumScore >= 45) {
    return {
      buyPriority: 'BUY',
      reasoning: `Strong company (${riskProfile}): avg ${avgScore.toFixed(0)}/100, small position ${position.toFixed(1)}% - Quality ${qualityScore}, Earnings ${earningsScore}`,
      dataCompleteness,
      missingData,
    };
  }

  const qualityPositionLimit = thresholds.maxPosition * 0.5; // Can buy if < 50% of max
  if (isQuality && position < qualityPositionLimit && momentumScore >= 50) {
    return {
      buyPriority: 'BUY',
      reasoning: `Exceptional quality (${riskProfile}): avg ${avgScore.toFixed(0)}/100, position ${position.toFixed(1)}% has room`,
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
