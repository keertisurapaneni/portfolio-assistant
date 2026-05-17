/**
 * Shared Auto-Trader Config — Single Source of Truth
 *
 * This file defines the AutoTraderConfig interface and DEFAULT values.
 * Imported by: auto-trader, frontend app, auto-tune edge function.
 * DO NOT duplicate these defaults elsewhere.
 */

export interface AutoTraderConfig {
  enabled: boolean;
  maxPositions: number;
  positionSize: number;
  minScannerConfidence: number;
  minFAConfidence: number;
  minSuggestedFindsConviction: number;
  accountId: string | null;
  dayTradeAutoClose: boolean;
  maxTotalAllocation: number;
  maxDailyDeployment: number;
  useDynamicSizing: boolean;
  portfolioValue: number;
  baseAllocationPct: number;
  maxPositionPct: number;
  riskPerTradePct: number;
  dipBuyEnabled: boolean;
  dipBuyTier1Pct: number; dipBuyTier1SizePct: number;
  dipBuyTier2Pct: number; dipBuyTier2SizePct: number;
  dipBuyTier3Pct: number; dipBuyTier3SizePct: number;
  dipBuyCooldownHours: number;
  profitTakeEnabled: boolean;
  profitTakeTier1Pct: number; profitTakeTier1TrimPct: number;
  profitTakeTier2Pct: number; profitTakeTier2TrimPct: number;
  profitTakeTier3Pct: number; profitTakeTier3TrimPct: number;
  minHoldPct: number;
  lossCutEnabled: boolean;
  lossCutTier1Pct: number; lossCutTier1SellPct: number;
  lossCutTier2Pct: number; lossCutTier2SellPct: number;
  lossCutTier3Pct: number; lossCutTier3SellPct: number;
  lossCutMinHoldDays: number;
  marketRegimeEnabled: boolean;
  maxSectorPct: number;
  earningsAvoidEnabled: boolean;
  earningsBlackoutDays: number;
  kellyAdaptiveEnabled: boolean;
  longTermBucketPct: number;
  /** Flat dollar size for influencer daily signal trades. 0 = use dynamic sizing. */
  externalSignalPositionSize: number;
  swingMaxHoldDays: number;
  capitalPressureEnabled: boolean;
  ltStopLossPct: number;
  ltProfitTakePct: number;
  ltMaxHoldDays: number;
  ltTrailingStopPct: number;
  dayTradeMaxDailyLoss: number;
  tradeSignalsEnabled: boolean;
  suggestedFindsEnabled: boolean;
  optionsWheelEnabled: boolean;
  pennyEnabled: boolean;
  pennyPositionSize: number;
  pennyMaxDailyLoss: number;
  pennyMaxDailyTrades: number;
  trendFilterEnabled: boolean;
  // Dual-account routing
  modeRouting: Record<string, 'paper' | 'live'>;
  liveKillSwitch: boolean;
  liveDailyLossLimit: number;
  livePortfolioValue: number;
  livePositionSize: number;
  liveMaxPositions: number;
  liveMaxDailyDeployment: number;
}

export const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  maxPositions: 3,
  positionSize: 1000,
  minScannerConfidence: 7,
  minFAConfidence: 7,
  minSuggestedFindsConviction: 8,
  accountId: null,
  dayTradeAutoClose: true,
  maxTotalAllocation: 500_000,
  maxDailyDeployment: 50_000,
  useDynamicSizing: true,
  portfolioValue: 1_000_000,
  baseAllocationPct: 2.0,
  maxPositionPct: 5.0,
  riskPerTradePct: 1.0,
  dipBuyEnabled: true,
  dipBuyTier1Pct: 10, dipBuyTier1SizePct: 25,
  dipBuyTier2Pct: 20, dipBuyTier2SizePct: 50,
  dipBuyTier3Pct: 30, dipBuyTier3SizePct: 75,
  dipBuyCooldownHours: 72,
  profitTakeEnabled: true,
  profitTakeTier1Pct: 8, profitTakeTier1TrimPct: 25,
  profitTakeTier2Pct: 15, profitTakeTier2TrimPct: 30,
  profitTakeTier3Pct: 25, profitTakeTier3TrimPct: 30,
  minHoldPct: 15,
  lossCutEnabled: true,
  lossCutTier1Pct: 6, lossCutTier1SellPct: 30,
  lossCutTier2Pct: 12, lossCutTier2SellPct: 50,
  lossCutTier3Pct: 20, lossCutTier3SellPct: 100,
  lossCutMinHoldDays: 1,
  marketRegimeEnabled: true,
  maxSectorPct: 30,
  earningsAvoidEnabled: true,
  earningsBlackoutDays: 3,
  kellyAdaptiveEnabled: false,
  longTermBucketPct: 50,
  externalSignalPositionSize: 5000,
  swingMaxHoldDays: 5,
  capitalPressureEnabled: true,
  ltStopLossPct: -12,
  ltProfitTakePct: 15,
  ltMaxHoldDays: 0,
  ltTrailingStopPct: 10,
  dayTradeMaxDailyLoss: 500,
  tradeSignalsEnabled: true,
  suggestedFindsEnabled: true,
  optionsWheelEnabled: true,
  pennyEnabled: false,
  pennyPositionSize: 200,
  pennyMaxDailyLoss: 200,
  pennyMaxDailyTrades: 10,
  trendFilterEnabled: true,
  // Dual-account routing — all modes default to paper for safety
  modeRouting: {
    DAY_TRADE: 'paper',
    SWING_TRADE: 'paper',
    OPTIONS_PUT: 'paper',
    OPTIONS_CALL: 'paper',
    CALENDAR_SPREAD: 'paper',
    CREDIT_SPREAD: 'paper',
    DAY_PENNY: 'paper',
    LONG_TERM: 'paper',
    EARNINGS_CALENDAR: 'paper',
  },
  liveKillSwitch: true,
  liveDailyLossLimit: -500,
  livePortfolioValue: 100_000,
  livePositionSize: 500,
  liveMaxPositions: 2,
  liveMaxDailyDeployment: 5_000,
};
