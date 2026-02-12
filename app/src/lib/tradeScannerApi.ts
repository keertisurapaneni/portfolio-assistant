/**
 * Trade Scanner API — calls the trade-scanner Supabase Edge Function.
 * Discovers market movers via Yahoo, evaluates with Gemini AI (same brain
 * as full analysis), caches in Supabase DB shared across all users.
 */

const TRADE_SCANNER_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trade-scanner`;

export interface TradeIdea {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  signal: 'BUY' | 'SELL';
  confidence: number;     // 0-10 AI confidence (same scale as full analysis)
  reason: string;         // AI-generated 1-sentence rationale
  tags: string[];         // e.g. ["momentum", "volume-surge"]
  mode: 'DAY_TRADE' | 'SWING_TRADE';
}

export interface ScanResult {
  dayTrades: TradeIdea[];
  swingTrades: TradeIdea[];
  timestamp: number;
  cached?: boolean;
}

export async function fetchTradeIdeas(
  portfolioTickers?: string[]
): Promise<ScanResult> {
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(TRADE_SCANNER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ portfolioTickers: portfolioTickers ?? [] }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `Scanner request failed: ${res.status}`);
  }
  return data as ScanResult;
}
