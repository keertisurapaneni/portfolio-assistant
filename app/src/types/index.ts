// Core data types for Portfolio Assistant

export interface Stock {
  ticker: string;
  name: string;
  dateAdded: string;
  lastDataFetch?: string; // ISO timestamp of last successful data refresh
  // Position data (optional - from CSV import)
  shares?: number;
  avgCost?: number;
  // Price data (from Yahoo Finance)
  currentPrice?: number;
  priceChange?: number; // Dollar change from previous close
  priceChangePercent?: number; // Percentage change
  volume?: number; // Trading volume (for liquidity risk)
  // Cached scores (refreshed from Yahoo Finance)
  qualityScore?: number;
  momentumScore?: number;
  earningsScore?: number;
  analystScore?: number;
  previousScore?: number; // Previous conviction score (for delta tracking)
  // Fundamental metrics (for display)
  eps?: number | null;
  peRatio?: number | null;
  roe?: number | null;
  profitMargin?: number | null;
  operatingMargin?: number | null;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  // Analyst rating details
  analystRating?: {
    rating: string;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    targetMean: number;
    targetHigh: number;
    targetLow: number;
  };
  // Quarterly EPS data from Yahoo Finance
  quarterlyEPS?: QuarterlyEPS[];
  // Recent news (last 7 days)
  recentNews?: {
    headline: string;
    summary?: string;
    source: string;
    datetime: number;
    url: string;
  }[];
}

export interface QuarterlyEPS {
  date: string;
  period: string;
  fiscalYear: string;
  eps: number;
  revenue: number;
}

export interface ScoreInputs {
  qualityScore: number;
  momentumScore: number;
  earningsScore: number;
  analystScore: number;
}

export type Posture = 'Buy' | 'Hold' | 'Sell';
export type Confidence = 'High' | 'Medium' | 'Low';

export interface ConvictionResult {
  score: number;
  posture: Posture;
  confidence: Confidence;
  rationale: string[];
}

export interface SuggestedStock {
  ticker: string;
  name: string;
  tag: 'Quiet Compounder' | 'Gold Mine';
  reason: string;
}

export type RiskProfile = 'aggressive' | 'moderate' | 'conservative';

export interface PortfolioSettings {
  riskProfile: RiskProfile;
  portfolioPeakValue?: number; // Track all-time high for drawdown calculation
  lastPeakDate?: string;
}

export interface UserData {
  stocks: Stock[];
  lastUpdated: string;
  settings?: PortfolioSettings;
}

// UI state types
export type ActiveTab = 'portfolio' | 'suggested' | 'movers';

export interface StockWithConviction extends Stock {
  conviction: ConvictionResult;
  buyPriority?: 'BUY' | 'SELL' | null; // AI/rule-based trade signal (null = no action)
  buyPriorityReasoning?: string; // AI-generated context-aware reasoning
  positionValue?: number;
  portfolioWeight?: number;
  isLoading?: boolean; // True while fetching real data
}

// CSV Import types
export interface ParsedRow {
  ticker?: string;
  name?: string;
  shares?: number;
  avgCost?: number;
  [key: string]: string | number | undefined;
}

export interface ColumnMapping {
  ticker: string | null;
  shares: string | null;
  avgCost: string | null;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
}
