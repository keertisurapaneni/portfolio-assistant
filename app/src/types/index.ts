// Core data types for Portfolio Assistant

export interface Stock {
  ticker: string;
  name: string;
  dateAdded: string;
  // Position data (optional - from CSV import)
  shares?: number;
  avgCost?: number;
  // Price data (from Yahoo Finance)
  currentPrice?: number;
  priceChange?: number; // Dollar change from previous close
  priceChangePercent?: number; // Percentage change
  // Cached scores (refreshed from Yahoo Finance)
  qualityScore?: number;
  momentumScore?: number;
  earningsScore?: number;
  analystScore?: number;
  // Fundamental metrics (for display)
  eps?: number | null;
  peRatio?: number | null;
  roe?: number | null;
  profitMargin?: number | null;
  operatingMargin?: number | null;
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

export interface UserData {
  stocks: Stock[];
  lastUpdated: string;
}

// UI state types
export type ActiveTab = 'portfolio' | 'suggested';

export interface StockWithConviction extends Stock {
  conviction: ConvictionResult;
  buyPriority?: 'BUY' | 'SELL' | null; // AI/rule-based trade signal (null = no action)
  previousScore?: number;
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
  name: string | null;
  shares: string | null;
  avgCost: string | null;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
}
