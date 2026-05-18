/**
 * Fundamental quality grader for options wheel candidates.
 * Uses Finnhub /stock/metric?metric=all to score stocks A-F.
 * Results are cached in memory with 24h TTL.
 */

import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';

export type FundamentalGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface FundamentalResult {
  grade: FundamentalGrade;
  score: number;
  breakdown: Record<string, { raw: number | null; points: number }>;
}

interface CacheEntry {
  result: FundamentalResult;
  ts: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

interface FinnhubMetricAll {
  metric?: Record<string, number | null>;
}

function gradeFromScore(score: number): FundamentalGrade {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

/**
 * Score a single metric on a 0-20 scale (6 metrics × ~16.7 each = 100 max).
 * Each metric maps raw value to a 0–16.7 point score using piecewise linear bands.
 */
function scorePE(pe: number | null): number {
  if (pe == null || pe <= 0) return 5; // no data or negative earnings → neutral
  if (pe <= 12) return 16.7;
  if (pe <= 18) return 14;
  if (pe <= 25) return 11;
  if (pe <= 35) return 7;
  if (pe <= 50) return 4;
  return 1;
}

function scoreDebtEquity(de: number | null): number {
  if (de == null) return 8; // no data → neutral
  if (de < 0) return 3;    // negative equity
  if (de <= 0.3) return 16.7;
  if (de <= 0.7) return 14;
  if (de <= 1.2) return 11;
  if (de <= 2.0) return 7;
  if (de <= 3.0) return 4;
  return 1;
}

function scoreROE(roe: number | null): number {
  if (roe == null) return 5;
  if (roe >= 25) return 16.7;
  if (roe >= 18) return 14;
  if (roe >= 12) return 11;
  if (roe >= 6) return 7;
  if (roe >= 0) return 4;
  return 1;
}

function scoreRevenueGrowth(growth: number | null): number {
  if (growth == null) return 5;
  if (growth >= 20) return 16.7;
  if (growth >= 12) return 14;
  if (growth >= 5) return 11;
  if (growth >= 0) return 7;
  if (growth >= -5) return 4;
  return 1;
}

function scoreCurrentRatio(cr: number | null): number {
  if (cr == null) return 8;
  if (cr >= 2.0) return 16.7;
  if (cr >= 1.5) return 14;
  if (cr >= 1.2) return 11;
  if (cr >= 1.0) return 7;
  if (cr >= 0.7) return 4;
  return 1;
}

function scoreGrossMargin(gm: number | null): number {
  if (gm == null) return 5;
  if (gm >= 60) return 16.7;
  if (gm >= 45) return 14;
  if (gm >= 30) return 11;
  if (gm >= 20) return 7;
  if (gm >= 10) return 4;
  return 1;
}

export async function getFundamentalGrade(ticker: string, isIndexEtf = false): Promise<FundamentalResult> {
  if (isIndexEtf) {
    return { grade: 'B', score: 65, breakdown: {} };
  }

  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  let metrics: Record<string, number | null> = {};
  try {
    const data = await finnhubFetch<FinnhubMetricAll>(
      `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`,
    );
    if (data) {
      metrics = data.metric ?? {};
    }
  } catch {
    return { grade: 'C', score: 50, breakdown: {} };
  }

  const pe = metrics.peBasicExclExtraTTM ?? metrics.peTTM ?? null;
  const de = metrics.totalDebtToEquityQuarterly ?? metrics.totalDebtToEquityAnnual ?? null;
  const roe = metrics.roeTTM ?? metrics.roeRfy ?? null;
  const revGrowth = metrics.revenueGrowthQuarterlyYoy ?? metrics.revenueGrowthTTMYoy ?? null;
  const cr = metrics.currentRatioQuarterly ?? metrics.currentRatioAnnual ?? null;
  const gm = metrics.grossMarginTTM ?? metrics.grossMarginAnnual ?? null;

  const breakdown: Record<string, { raw: number | null; points: number }> = {
    pe: { raw: pe, points: scorePE(pe) },
    debtEquity: { raw: de, points: scoreDebtEquity(de) },
    roe: { raw: roe, points: scoreROE(roe) },
    revenueGrowth: { raw: revGrowth, points: scoreRevenueGrowth(revGrowth) },
    currentRatio: { raw: cr, points: scoreCurrentRatio(cr) },
    grossMargin: { raw: gm, points: scoreGrossMargin(gm) },
  };

  const score = Math.round(Object.values(breakdown).reduce((s, v) => s + v.points, 0));
  const grade = gradeFromScore(score);
  const result: FundamentalResult = { grade, score, breakdown };

  cache.set(ticker, { result, ts: Date.now() });
  return result;
}

export function clearFundamentalCache(): void {
  cache.clear();
}
