/**
 * Trading Signals API — calls the trading-signals Supabase Edge Function.
 * Request: ticker + mode (AUTO | DAY_TRADE | SWING_TRADE).
 * Response: { trade, indicators, marketSnapshot, chart }.
 */

const TRADING_SIGNALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-signals`;

export type SignalsMode = 'AUTO' | 'DAY_TRADE' | 'SWING_TRADE';

export interface TradeSignal {
  mode: string;
  detectedMode?: string;       // only present when AUTO was requested
  autoReason?: string;         // explains why AUTO chose day/swing
  recommendation: 'BUY' | 'SELL' | 'HOLD';
  bias: string;                // e.g. "Bullish continuation"
  entryPrice: number | null;
  stopLoss: number | null;
  targetPrice: number | null;
  targetPrice2: number | null; // stretch target
  riskReward: string | null;
  rationale: { technical?: string; sentiment?: string; risk?: string };
  confidence: number;          // 0-10 scale
  scenarios: {
    bullish: { probability: number; summary: string };
    neutral: { probability: number; summary: string };
    bearish: { probability: number; summary: string };
  };
}

export type CrossoverState = 'bullish_cross' | 'bearish_cross' | 'above' | 'below' | null;
export type TrendLabel = 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend';

export interface IndicatorValues {
  rsi: number | null;
  macd: { value: number; signal: number; histogram: number } | null;
  ema20: number | null;
  sma50: number | null;
  sma200: number | null;
  atr: number | null;
  adx: number | null;
  volumeRatio: number | null;
  emaCrossover: CrossoverState;
  trend: TrendLabel;
}

export interface MarketSnapshot {
  bias: string;
  volatility: string;
  spyTrend: string;
  vix: number;
}

export interface ChartCandle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ChartOverlay {
  type: string;
  label: string;
  price: number;
}

export interface TradingSignalsResponse {
  trade: TradeSignal;
  indicators: IndicatorValues;
  marketSnapshot: MarketSnapshot | null;
  chart: {
    timeframe: string;
    candles: ChartCandle[];
    overlays: ChartOverlay[];
  };
}

const STORAGE_KEY_MODE = 'trading-signals-mode';

export function getStoredMode(): SignalsMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY_MODE);
    if (v === 'AUTO' || v === 'DAY_TRADE' || v === 'SWING_TRADE') return v;
  } catch {
    /* ignore */
  }
  return 'AUTO';
}

export function setStoredMode(mode: SignalsMode): void {
  try {
    localStorage.setItem(STORAGE_KEY_MODE, mode);
  } catch {
    /* ignore */
  }
}

export async function fetchTradingSignal(
  ticker: string,
  mode: SignalsMode
): Promise<TradingSignalsResponse> {
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(TRADING_SIGNALS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ ticker: ticker.trim().toUpperCase(), mode }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed: ${res.status}`);
  }
  return data as TradingSignalsResponse;
}
