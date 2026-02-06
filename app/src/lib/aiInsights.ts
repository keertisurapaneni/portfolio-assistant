/**
 * AI-powered insights using lightweight LLM
 * All AI calls go through Supabase Edge Function (API key stays server-side)
 */

import type { Stock, RiskProfile } from '../types';

const AI_PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-proxy`;

// Global cooldown: after a 429, pause before the next AI call
let rateLimitedUntil = 0;

/**
 * Call AI through the secure proxy (Groq/Llama 3.3 — never exposes API key to browser).
 * If a cooldown is active (from a previous 429), waits for it to expire then retries.
 * On a fresh 429, activates a cooldown and throws (caller will retry next stock later).
 */
async function callAI(prompt: string, temperature = 0.1, maxOutputTokens = 2000): Promise<string> {
  // If we're in cooldown, WAIT for it to expire instead of failing immediately
  if (Date.now() < rateLimitedUntil) {
    const waitMs = rateLimitedUntil - Date.now();
    const secsLeft = Math.ceil(waitMs / 1000);
    console.log(`[AI] Rate-limit cooldown active — waiting ${secsLeft}s...`);
    await new Promise(resolve => setTimeout(resolve, waitMs + 500)); // +500ms buffer
  }

  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const response = await fetch(AI_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ prompt, temperature, maxOutputTokens }),
  });

  if (response.status === 429) {
    // Back off for 15 seconds — Edge Function already tries fallback model,
    // so a 429 here means both models are hot; short cooldown + retry handles it
    rateLimitedUntil = Date.now() + 15_000;
    console.warn('[AI] 429 received — cooldown activated for 15s');
    throw new Error('AI rate-limited — try again in 15s');
  }

  if (!response.ok) {
    throw new Error(`AI proxy error: ${response.status}`);
  }

  const data = await response.json();
  return data.text ?? '';
}

export interface AIInsight {
  summary: string; // 1-2 sentence contextual summary
  buyPriority: 'BUY' | 'SELL' | null; // Binary trade decision
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null; // AI conviction level
  reasoning: string; // Full detailed rationale (shown in detail view)
  cardNote: string; // 5-8 word summary for the main card
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
const PROMPT_VERSION = 33; // v33: Removed mechanical profit-take SELL — AI evaluates quality stocks with gains
const CACHE_KEY_PREFIX = `ai-insight-v${PROMPT_VERSION}-`;
const CACHE_DURATION = 1000 * 60 * 60 * 4; // 4 hours (refresh more often during trading day)

/**
 * Get cached insight if available and fresh
 */
export function getCachedInsight(ticker: string): AIInsight | null {
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
 * Clear all cached AI insights — call when risk profile changes
 * so the AI re-evaluates with the new profile
 */
export function clearAllInsightCache(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    console.log(`[AI Cache] Cleared ${keysToRemove.length} cached insights for risk profile change`);
  } catch { /* */ }
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

// Auto-clear stale cache from old prompt versions on module load
try {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (
      key &&
      (key.startsWith('ai-card-') || key.startsWith('ai-insight-')) &&
      !key.startsWith(CACHE_KEY_PREFIX)
    ) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    console.log(`[AI Cache] Clearing ${keysToRemove.length} stale cache entries`);
    keysToRemove.forEach(k => localStorage.removeItem(k));
  }
} catch {
  /* */
}

/**
 * Generate AI insights for a stock using Groq (Llama 3.3 70B)
 * Free tier: 30 RPM, routed through Supabase Edge Function
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

  // Calculate liquidity risk
  const liquidity = calculateLiquidityRisk(volume);

  // ── Risk-profile-adjusted thresholds (must match generateRuleBased) ──
  const guardrails = {
    aggressive: { stopLoss: -10, profitTake: 25, rebalanceAt: 30 },
    moderate: { stopLoss: -7, profitTake: 20, rebalanceAt: 25 },
    conservative: { stopLoss: -4, profitTake: 20, rebalanceAt: 20 },
  }[riskProfile ?? 'moderate'];

  // ── Client-side trigger detection ──
  // Only call the 70B model when there's a reason to act. This keeps us
  // well within Groq's free-tier 100K TPD limit for llama-3.3-70b-versatile.
  const avgScore = Math.round((qualityScore + earningsScore + momentumScore + analystScore) / 4);
  const triggers: string[] = [];

  // Price move trigger: significant daily change
  if (priceChangePercent !== undefined && Math.abs(priceChangePercent) >= 2.5) {
    triggers.push(`price ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(1)}%`);
  }

  // Stop-loss trigger: from purchase price (risk-adjusted)
  if (avgCost && stock.currentPrice && avgCost > 0) {
    const gainLossPct = ((stock.currentPrice - avgCost) / avgCost) * 100;
    if (gainLossPct <= guardrails.stopLoss)
      triggers.push(`stop-loss zone (${gainLossPct.toFixed(1)}%)`);
    if (gainLossPct >= guardrails.profitTake)
      triggers.push(`profit-take zone (+${gainLossPct.toFixed(1)}%)`);
  }

  // Overconcentration trigger (risk-adjusted)
  if (portfolioWeight && portfolioWeight > guardrails.rebalanceAt) {
    triggers.push(`overconcentrated (${portfolioWeight.toFixed(1)}%)`);
  }

  // 52-week range trigger: 15%+ off high with quality scores
  const high52 = stock.fiftyTwoWeekHigh ?? 0;
  const curPrice = stock.currentPrice ?? 0;
  if (high52 > 0 && curPrice > 0) {
    const offHigh = ((high52 - curPrice) / high52) * 100;
    if (offHigh >= 15 && avgScore >= 65) triggers.push(`${offHigh.toFixed(0)}% off 52W high`);
  }

  // Earnings/news trigger: detect earnings keywords in recent headlines
  if (recentNews && recentNews.length > 0) {
    const earningsKeywords = [
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
    ];
    const hasEarnings = recentNews.some(n =>
      earningsKeywords.some(kw => (n.headline || '').toLowerCase().includes(kw))
    );
    if (hasEarnings) triggers.push('earnings news');
  }

  // ── Mechanical SELL guardrails — only for capital protection ──
  // Stop-loss is mechanical (protect capital, no debate).
  // Profit-take is NOT mechanical — a quality stock up 20% may have more to run.
  // Instead, profit-take is a trigger that sends the stock to AI for evaluation.
  if (avgCost && stock.currentPrice && avgCost > 0) {
    const gainLossPct = ((stock.currentPrice - avgCost) / avgCost) * 100;
    if (gainLossPct <= guardrails.stopLoss) {
      const sellInsight: AIInsight = {
        summary: stock.name || stock.ticker,
        buyPriority: 'SELL',
        confidence: 'HIGH',
        reasoning: `Down ${Math.abs(gainLossPct).toFixed(1)}% from your $${avgCost.toFixed(2)} entry — stop-loss triggered (${riskProfile ?? 'moderate'} profile: ${guardrails.stopLoss}%). Protect capital and reassess.`,
        cardNote: `Stop-loss: ${gainLossPct.toFixed(1)}% from entry`,
        dataCompleteness: 'FULL',
        liquidityRisk: liquidity.risk,
        liquidityWarning: liquidity.warning,
        cached: false,
        timestamp: new Date().toISOString(),
      };
      cacheInsight(stock.ticker, sellInsight);
      return sellInsight;
    }
    // Profit-take zone: NOT an automatic SELL — AI evaluates based on fundamentals
    // The trigger was already added above (line ~209) so AI will see it
  }
  if (portfolioWeight && portfolioWeight > guardrails.rebalanceAt) {
    const sellInsight: AIInsight = {
      summary: stock.name || stock.ticker,
      buyPriority: 'SELL',
      confidence: 'HIGH',
      reasoning: `Position is ${portfolioWeight.toFixed(1)}% of portfolio — overconcentrated (${riskProfile ?? 'moderate'} profile limit: ${guardrails.rebalanceAt}%). Trim to manage risk.`,
      cardNote: `Overconcentrated: ${portfolioWeight.toFixed(1)}% of portfolio`,
      dataCompleteness: 'FULL',
      liquidityRisk: liquidity.risk,
      liquidityWarning: liquidity.warning,
      cached: false,
      timestamp: new Date().toISOString(),
    };
    cacheInsight(stock.ticker, sellInsight);
    return sellInsight;
  }
  if (avgScore < 35 && momentumScore < 35) {
    const sellInsight: AIInsight = {
      summary: stock.name || stock.ticker,
      buyPriority: 'SELL',
      confidence: 'MEDIUM',
      reasoning: `Weak fundamentals (avg score ${avgScore}) and poor momentum (${momentumScore}) — review if the thesis still holds.`,
      cardNote: `Weak fundamentals + momentum`,
      dataCompleteness: 'FULL',
      liquidityRisk: liquidity.risk,
      liquidityWarning: liquidity.warning,
      cached: false,
      timestamp: new Date().toISOString(),
    };
    cacheInsight(stock.ticker, sellInsight);
    return sellInsight;
  }

  // No triggers → skip AI call, return null instantly
  if (triggers.length === 0) {
    console.log(`[AI Insights] No triggers for ${stock.ticker} — skipping AI call`);
    const noActionInsight: AIInsight = {
      summary: stock.name || stock.ticker,
      buyPriority: null,
      confidence: null,
      reasoning: 'No significant triggers today — no action needed.',
      cardNote: 'No triggers, hold steady',
      dataCompleteness: 'FULL',
      liquidityRisk: liquidity.risk,
      liquidityWarning: liquidity.warning,
      cached: false,
      timestamp: new Date().toISOString(),
    };
    cacheInsight(stock.ticker, noActionInsight);
    return noActionInsight;
  }

  console.log(`[AI Insights] Triggers for ${stock.ticker}: ${triggers.join(', ')}`);

  try {
    console.log(`[AI Insights] Calling 70B for ${stock.ticker}...`);

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

    // 52-week range context (compact)
    let rangeContext = '';
    const high52 = stock.fiftyTwoWeekHigh ?? 0;
    const low52 = stock.fiftyTwoWeekLow ?? 0;
    const curPrice = stock.currentPrice ?? 0;
    if (high52 > 0 && low52 > 0 && curPrice > 0) {
      const offHigh = ((high52 - curPrice) / high52) * 100;
      rangeContext = ` | 52W: $${low52.toFixed(0)}-$${high52.toFixed(0)}, ${offHigh.toFixed(1)}% off high`;
    }

    // Price change (compact)
    const priceChangeText =
      priceChangePercent !== undefined
        ? `${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}% today`
        : 'N/A';

    // Gain/loss from purchase (compact — triggers trading rules)
    let gainLossContext = '';
    if (avgCost && stock.currentPrice && avgCost > 0) {
      const gainLossPct = ((stock.currentPrice - avgCost) / avgCost) * 100;
      if (gainLossPct <= -7) {
        gainLossContext = ` | STOP-LOSS: ${gainLossPct.toFixed(1)}% from cost $${avgCost.toFixed(2)}`;
      } else if (gainLossPct >= 20) {
        gainLossContext = ` | PROFIT-TAKE: +${gainLossPct.toFixed(1)}% from cost $${avgCost.toFixed(2)}`;
      } else {
        gainLossContext = ` | P&L: ${gainLossPct >= 0 ? '+' : ''}${gainLossPct.toFixed(1)}% from $${avgCost.toFixed(2)}`;
      }
    }

    // Wall Street consensus (compact)
    let analystContext = '';
    if (analystRating) {
      const total =
        analystRating.strongBuy +
        analystRating.buy +
        analystRating.hold +
        analystRating.sell +
        analystRating.strongSell;
      const bullish = analystRating.strongBuy + analystRating.buy;
      const bullishPct = total > 0 ? ((bullish / total) * 100).toFixed(0) : '0';
      const upsidePct =
        stock.currentPrice && analystRating.targetMean > 0
          ? (((analystRating.targetMean - stock.currentPrice) / stock.currentPrice) * 100).toFixed(
              1
            )
          : null;

      analystContext = `\nAnalysts: ${bullishPct}% bullish (${total}), target $${analystRating.targetMean.toFixed(0)}${upsidePct ? ` (${upsidePct}% upside)` : ''}`;
    }

    // Recent news (compact — headlines only, max 5)
    let newsContext = '';
    if (recentNews && recentNews.length > 0) {
      const newsItems = recentNews
        .slice(0, 5)
        .map(news => {
          const hoursAgo = Math.floor((Date.now() - news.datetime * 1000) / (1000 * 60 * 60));
          const timeStr =
            hoursAgo < 1 ? 'now' : hoursAgo < 24 ? `${hoursAgo}h` : `${Math.floor(hoursAgo / 24)}d`;
          return `[${timeStr}] ${news.headline}`;
        })
        .join('\n');
      newsContext = `\nNews:\n${newsItems}`;
    }

    const avgScore = Math.round((qualityScore + earningsScore + momentumScore + analystScore) / 4);

    // Compact prompt — all rules/examples are in the system message (Edge Function)
    const prompt = `${stock.ticker} (${stock.name || stock.ticker})
Today: ${priceChangeText}${rangeContext}${gainLossContext}
Position: ${positionContext}${!hasPositionData ? ' [not imported]' : ''}
Scores: Q:${qualityScore} E:${earningsScore} M:${momentumScore} A:${analystScore} Avg:${avgScore}/100
${metrics.length > 0 ? metrics.join(', ') : ''}${analystContext}${newsContext}
Risk: ${riskProfile || 'moderate'}`;

    const rawText = await callAI(prompt, 0.3, 500);
    console.log(
      `[AI Insights] Raw response for ${stock.ticker} (${rawText.length} chars):`,
      rawText.slice(0, 200)
    );

    // Try to parse JSON response — handle markdown wrapping, thinking artifacts, etc.
    let parsedResponse: {
      buyPriority?: string;
      confidence?: string;
      reasoning?: string;
      cardNote?: string;
      summary?: string;
    } = {};

    try {
      // Clean up: remove think tags, markdown fences, trim whitespace
      const cleaned = rawText
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/```json?\s*/g, '')
        .replace(/```/g, '')
        .trim();
      // Find the JSON object anywhere in the text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
        console.log(
          `[AI Insights] Parsed for ${stock.ticker}:`,
          parsedResponse.buyPriority,
          parsedResponse.reasoning?.slice(0, 80)
        );
      } else {
        console.warn(`[AI Insights] No JSON found in response for ${stock.ticker}`);
      }
    } catch (e) {
      console.warn(`[AI Insights] Could not parse JSON for ${stock.ticker}:`, e);
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

    // Map buyPriority: accept "BUY", "SELL", or treat everything else as null
    let aiBuyPriority: AIInsight['buyPriority'] = null;
    if (parsedResponse.buyPriority === 'BUY') aiBuyPriority = 'BUY';
    else if (parsedResponse.buyPriority === 'SELL') aiBuyPriority = 'SELL';

    // Map confidence: accept HIGH, MEDIUM, LOW
    let aiConfidence: AIInsight['confidence'] = null;
    if (parsedResponse.confidence === 'HIGH') aiConfidence = 'HIGH';
    else if (parsedResponse.confidence === 'MEDIUM') aiConfidence = 'MEDIUM';
    else if (parsedResponse.confidence === 'LOW') aiConfidence = 'LOW';

    const insight: AIInsight = {
      summary:
        parsedResponse.summary ||
        generateEnhancedSummary(stock, qualityScore, earningsScore, analystScore),
      buyPriority: aiBuyPriority,
      confidence: aiConfidence,
      reasoning: parsedResponse.reasoning || ruleBased.reasoning,
      cardNote: parsedResponse.cardNote || '',
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
      confidence: ruleBased.buyPriority ? 'MEDIUM' : null,
      reasoning: ruleBased.reasoning,
      cardNote:
        ruleBased.reasoning.length > 50
          ? ruleBased.reasoning.slice(0, 47) + '...'
          : ruleBased.reasoning,
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
  _recentNews?: Array<{ headline: string; datetime: number }>,
  _fiftyTwoWeekHigh?: number,
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
    aggressive: { stopLoss: -10, rebalanceAt: 30 },
    moderate: { stopLoss: -7, rebalanceAt: 25 },
    conservative: { stopLoss: -4, rebalanceAt: 20 },
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

  // ── SELL SIGNALS (mechanical guardrails only) ──

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

  // ── NO BUY SIGNALS from rule-based ──
  // BUY decisions are made ONLY by the AI (generateAIInsights).
  // Rule-based only handles mechanical SELL guardrails above.

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

