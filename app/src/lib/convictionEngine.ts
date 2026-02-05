import type { ScoreInputs, ConvictionResult, Posture, Confidence } from '../types';

/**
 * CONVICTION ENGINE v4
 *
 * Fully automated scoring - no manual thesis input
 *
 * 4 objective factors:
 * 1. Quality (30%) - Profitability, margins, financial health
 * 2. Earnings (30%) - EPS trend, beat/miss history
 * 3. Analyst (25%) - Wall Street consensus (similar to Zacks Rank)
 * 4. Momentum (15%) - Price trend, 52-week position
 */

const WEIGHTS = {
  quality: 0.3,
  earnings: 0.3,
  analyst: 0.25,
  momentum: 0.15,
};

// Thresholds for "red flag" conditions
const RED_FLAG_THRESHOLD = 25;
const SELL_THRESHOLD = 35;
const BUY_THRESHOLD = 60;

/**
 * Calculate conviction score from inputs.
 * 100% objective - no manual override.
 *
 * Key insight: If Wall Street strongly disagrees with fundamentals,
 * they may see a turnaround story we should respect.
 */
export function calculateConviction(inputs: ScoreInputs): number {
  // Check for RED FLAGS - objective signals of serious trouble
  const hasQualityRedFlag = inputs.qualityScore < RED_FLAG_THRESHOLD;
  const hasEarningsRedFlag = inputs.earningsScore < RED_FLAG_THRESHOLD;
  const hasCriticalRedFlag = hasQualityRedFlag && hasEarningsRedFlag;
  const hasAnyRedFlag = hasQualityRedFlag || hasEarningsRedFlag;

  // Check if Wall Street strongly disagrees (sees turnaround potential)
  const analystBullish = inputs.analystScore >= 65; // Buy or better
  const analystStrongBuy = inputs.analystScore >= 75;

  // Calculate raw score
  let raw =
    inputs.qualityScore * WEIGHTS.quality +
    inputs.momentumScore * WEIGHTS.momentum +
    inputs.earningsScore * WEIGHTS.earnings +
    inputs.analystScore * WEIGHTS.analyst;

  // Apply RED FLAG adjustments - BUT respect strong analyst disagreement
  if (hasCriticalRedFlag) {
    if (analystStrongBuy) {
      // Wall Street strongly bullish despite poor fundamentals → turnaround play
      raw = Math.max(raw, 40); // Floor at Hold territory
      console.log(
        '[Conviction] CRITICAL RED FLAG but Strong Buy consensus → floor at 40 (turnaround)'
      );
    } else if (analystBullish) {
      // Analysts see turnaround potential → set FLOOR in Hold territory
      raw = Math.max(raw, 38); // Floor just above Sell threshold (35)
      console.log('[Conviction] CRITICAL RED FLAG but Buy consensus → floor at 38 (turnaround)');
    } else {
      raw = Math.min(raw, 30);
      console.log('[Conviction] CRITICAL RED FLAG: Quality AND Earnings below 25 → capped at 30');
    }
  } else if (hasAnyRedFlag) {
    if (analystBullish) {
      // Single red flag but analysts bullish → set floor in Hold territory
      raw = Math.max(raw, 40);
      console.log('[Conviction] RED FLAG but Buy consensus → floor at 40');
    } else {
      raw = Math.min(raw, 45);
      console.log('[Conviction] RED FLAG: Quality or Earnings below 25 → capped at 45');
    }
  }

  // Extra penalty for severely impaired quality (but not if analysts see value)
  if (inputs.qualityScore < 15 && !analystBullish) {
    raw -= 10;
    console.log('[Conviction] Severe quality issues (< 15) → extra -10');
  }

  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Map score to Buy/Hold/Sell posture.
 */
export function getPosture(score: number): Posture {
  if (score >= BUY_THRESHOLD) return 'Buy';
  if (score >= SELL_THRESHOLD) return 'Hold';
  return 'Sell';
}

/**
 * Derive confidence from:
 * 1. Agreement between all 4 objective factors
 * 2. How far the score is from the thresholds
 * 3. Strength of individual signals
 *
 * Philosophy: Default to MEDIUM. High/Low are exceptional.
 */
export function getConfidence(inputs: ScoreInputs, finalScore: number): Confidence {
  // All 4 factors
  const allScores = [
    inputs.qualityScore,
    inputs.momentumScore,
    inputs.earningsScore,
    inputs.analystScore,
  ];

  // Calculate standard deviation (measure of agreement)
  const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const variance = allScores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / allScores.length;
  const stdDev = Math.sqrt(variance);

  // Distance from nearest threshold
  const distanceFromBuyThreshold = Math.abs(finalScore - BUY_THRESHOLD);
  const distanceFromSellThreshold = Math.abs(finalScore - SELL_THRESHOLD);
  const minDistance = Math.min(distanceFromBuyThreshold, distanceFromSellThreshold);

  // Count factors by strength
  const strong = allScores.filter(s => s >= 60).length; // Good (Buy territory)
  const veryWeak = allScores.filter(s => s <= 25).length; // Red flag
  const weak = allScores.filter(s => s <= 40).length; // Concerning
  const mixed = strong > 0 && weak > 0; // Conflicting signals

  // LOW confidence: signals conflict or we're near threshold
  // Also low if analysts strongly disagree with fundamentals (turnaround uncertainty)
  const fundamentalsWeak = inputs.qualityScore < 30 || inputs.earningsScore < 30;
  const analystBullish = inputs.analystScore >= 65;
  const turnaroundPlay = fundamentalsWeak && analystBullish;

  if (mixed || minDistance < 8 || stdDev > 22 || turnaroundPlay) {
    return 'Low';
  }

  // HIGH confidence conditions:
  // 1. Strong Buy: score >= 72 AND 3+ factors strong (>=60) AND analyst bullish AND no weak factors
  // 2. Strong Sell: score <= 30 AND 3+ factors very weak
  // High confidence when fundamentals + analyst consensus align strongly
  const analystBullishForHigh = inputs.analystScore >= 65;
  const strongBuySignal = finalScore >= 72 && strong >= 3 && analystBullishForHigh && weak === 0;
  const strongSellSignal = finalScore <= 30 && veryWeak >= 3;

  if (strongBuySignal || strongSellSignal) {
    return 'High';
  }

  // Default: MEDIUM (most common case)
  return 'Medium';
}

/**
 * Generate human-readable rationale bullets.
 */
export function generateRationale(inputs: ScoreInputs): string[] {
  const bullets: string[] = [];

  // Check for improving/declining trend (earnings score tells us recent trend)
  const earningsImproving = inputs.earningsScore >= 55; // Above neutral suggests improvement
  const qualityWeak = inputs.qualityScore < 40;

  // Quality assessment
  if (inputs.qualityScore >= 70) {
    bullets.push('Strong profitability and fundamentals');
  } else if (inputs.qualityScore < 15 && !earningsImproving) {
    bullets.push('🚨 UNPROFITABLE: Company is losing money');
  } else if (inputs.qualityScore < 25 && earningsImproving) {
    bullets.push('💡 Profitability improving (recent quarters positive)');
  } else if (inputs.qualityScore < 25) {
    bullets.push('⚠️ Major quality issues (negative margins/earnings)');
  } else if (inputs.qualityScore < 40) {
    bullets.push('Weak quality metrics');
  }

  // Earnings assessment
  if (inputs.earningsScore >= 70) {
    bullets.push('Strong earnings track record');
  } else if (inputs.earningsScore >= 60 && qualityWeak) {
    bullets.push('📈 Recent earnings improving (turning profitable)');
  } else if (inputs.earningsScore < 15) {
    bullets.push('🚨 PERSISTENT LOSSES: Multiple quarters of negative EPS');
  } else if (inputs.earningsScore < 25) {
    bullets.push('⚠️ Poor earnings history');
  } else if (inputs.earningsScore < 40) {
    bullets.push('Mixed earnings results');
  }

  // Analyst assessment
  if (inputs.analystScore >= 75) {
    bullets.push('📊 Wall Street: Strong Buy consensus');
  } else if (inputs.analystScore >= 60) {
    bullets.push('📊 Wall Street: Buy leaning');
  } else if (inputs.analystScore <= 25) {
    bullets.push('📊 Wall Street: Sell consensus');
  } else if (inputs.analystScore <= 40) {
    bullets.push('📊 Wall Street: Bearish sentiment');
  }

  // Momentum assessment
  if (inputs.momentumScore >= 70) {
    bullets.push('Positive price momentum');
  } else if (inputs.momentumScore < 30) {
    bullets.push('Negative price momentum');
  }

  // Red flag summary - adjusted for improving trends
  if (inputs.qualityScore < 25 && inputs.earningsScore < 25) {
    if (inputs.analystScore >= 65) {
      bullets.unshift('⚠️ Turnaround play: Weak fundamentals but Wall Street sees potential');
    } else {
      bullets.unshift('🚨 RED FLAG: Both quality and earnings severely impaired');
    }
  } else if (inputs.qualityScore < 25 && inputs.earningsScore >= 55) {
    // Recently turning profitable - highlight the positive trend
    bullets.unshift('💡 Growth story: Recently profitable with improving earnings');
  }

  return bullets.slice(0, 3);
}

/**
 * Get full conviction result for a stock.
 */
export function getConvictionResult(inputs: ScoreInputs): ConvictionResult {
  const score = calculateConviction(inputs);
  return {
    score,
    posture: getPosture(score),
    confidence: getConfidence(inputs, score),
    rationale: generateRationale(inputs),
  };
}
