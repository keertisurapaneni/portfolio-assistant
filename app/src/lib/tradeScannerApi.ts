/**
 * Trade Scanner API — calls the trade-scanner Supabase Edge Function.
 * Scans market movers + curated universe for high-confidence trade setups.
 * Returns day trade and swing trade ideas scored 0-100.
 */

const TRADE_SCANNER_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trade-scanner`;

export interface TradeIdea {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  score: number;        // 0-100 (only high-confidence ideas returned)
  reason: string;       // e.g. "Up 6.2% · Vol 3.1x avg"
  tags: string[];       // e.g. ["momentum", "volume-surge"]
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
