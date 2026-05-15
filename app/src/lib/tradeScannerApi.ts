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
  confidence: number;     // 0-10 Pass 2 confidence (same scale as full analysis)
  reason: string;        // AI-generated 1-sentence rationale
  tags: string[];        // e.g. ["momentum", "volume-surge"]
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'DAY_PENNY';
  // Pass 2 FA-grade levels — carried through so auto-trader can skip redundant FA call
  entryPrice?: number | null;
  stopLoss?: number | null;
  targetPrice?: number | null;
  riskReward?: string | null;
  atr?: number | null;
  in_play_score?: number;
  pass1_confidence?: number;
  market_condition?: 'trend' | 'chop';
  /** When true, bypasses the naked-short guard. Set for user-initiated manual trades. */
  allowShort?: boolean;
}

export interface KeyLevelSetup {
  ticker: string;
  name: string;
  price: number;
  atr: number;
  longTrigger: number;
  longStop: number;
  longT1: number;
  longT2: number | null;
  shortTrigger: number;
  shortStop: number;
  shortT1: number;
  shortT2: number | null;
  levelContext: string;
  setupScore: number;
  dollarVolume: number;
}

export interface ScanResult {
  dayTrades: TradeIdea[];
  swingTrades: TradeIdea[];
  keyLevelSetups: KeyLevelSetup[];
  timestamp: number;
  cached?: boolean;
}

export type ScanEvaluationStatus = 'armed' | 'watching' | 'blocked' | 'executed';

export interface ScanEvaluation {
  status: ScanEvaluationStatus;
  reason: string;
  evaluated_at: string;
}

/** Keyed by ticker (uppercased). Merged from both day_trades + swing_trades rows. */
export type ScanEvaluations = Record<string, ScanEvaluation>;

/** Fetch auto-trader gate evaluation results from trade_scans rows directly. */
export async function fetchScanEvaluations(): Promise<ScanEvaluations> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/trade_scans?id=in.(day_trades,swing_trades,penny_trades)&select=auto_evaluations`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!res.ok) return {};
    const rows: Array<{ auto_evaluations: Record<string, ScanEvaluation> }> = await res.json();
    // Merge both rows into a single ticker-keyed map
    return rows.reduce<ScanEvaluations>((acc, row) => ({ ...acc, ...row.auto_evaluations }), {});
  } catch {
    return {};
  }
}

export async function fetchTradeIdeas(
  portfolioTickers?: string[],
  forceRefresh = false,
  scanType?: 'day' | 'swing',
): Promise<ScanResult> {
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const body: Record<string, unknown> = { portfolioTickers: portfolioTickers ?? [], forceRefresh };
  if (scanType) body.scanType = scanType;
  const res = await fetch(TRADE_SCANNER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `Scanner request failed: ${res.status}`);
  }
  return data as ScanResult;
}

export async function fetchPennyTradeIdeas(): Promise<TradeIdea[]> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/trade_scans?id=eq.penny_trades&select=data`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!res.ok) return [];
    const rows: Array<{ data: TradeIdea[] }> = await res.json();
    return rows[0]?.data ?? [];
  } catch {
    return [];
  }
}
