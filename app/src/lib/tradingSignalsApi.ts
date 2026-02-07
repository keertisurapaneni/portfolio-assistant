/**
 * Trading Signals API — calls the trading-signals Supabase Edge Function.
 * Request: ticker + mode (DAY_TRADE | SWING_TRADE).
 * Response: { trade, chart } per technical spec.
 */

const TRADING_SIGNALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-signals`;

export type SignalsMode = 'DAY_TRADE' | 'SWING_TRADE';

export interface TradeSignal {
  mode: string;
  recommendation: 'BUY' | 'SELL' | 'HOLD';
  entryPrice: number | null;
  stopLoss: number | null;
  targetPrice: number | null;
  riskReward: string | null;
  rationale: { technical?: string; sentiment?: string; risk?: string };
  confidence: string;
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
    if (v === 'DAY_TRADE' || v === 'SWING_TRADE') return v;
  } catch {
    /* ignore */
  }
  return 'SWING_TRADE';
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
