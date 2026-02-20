/**
 * Strategy Videos API — reads from strategy_videos table (Supabase).
 * Single source of truth; replaces strategy-videos.json.
 */

import { supabase } from './supabaseClient';

export interface StrategyVideoRecord {
  id: string;
  video_id: string;
  platform: string;
  source_handle: string | null;
  source_name: string;
  reel_url: string | null;
  canonical_url: string | null;
  video_heading: string | null;
  strategy_type: 'daily_signal' | 'generic_strategy' | null;
  timeframe: string | null;
  applicable_timeframes: string[] | null;
  execution_window_et: { start?: string; end?: string } | null;
  trade_date: string | null;
  extracted_signals: unknown[] | null;
  exempt_from_auto_deactivation: boolean;
  status: string;
  summary: string | null;
  tracked_at: string | null;
}

/** Normalized shape for consumers (matches legacy JSON shape) */
export interface StrategyVideoNormalized {
  videoId: string;
  sourceHandle?: string;
  sourceName?: string;
  reelUrl?: string;
  canonicalUrl?: string;
  videoHeading?: string;
  strategyType?: 'daily_signal' | 'generic_strategy';
  timeframe?: string;
  applicableTimeframes?: string[];
  executionWindowEt?: { start?: string; end?: string };
  tradeDate?: string;
  extractedSignals?: unknown[];
  exemptFromAutoDeactivation?: boolean;
  status?: string;
}

function toNormalized(row: StrategyVideoRecord): StrategyVideoNormalized {
  return {
    videoId: row.video_id,
    sourceHandle: row.source_handle ?? undefined,
    sourceName: row.source_name,
    reelUrl: row.reel_url ?? undefined,
    canonicalUrl: row.canonical_url ?? undefined,
    videoHeading: row.video_heading ?? undefined,
    strategyType: row.strategy_type ?? undefined,
    timeframe: row.timeframe ?? undefined,
    applicableTimeframes: row.applicable_timeframes ?? undefined,
    executionWindowEt: row.execution_window_et ?? undefined,
    tradeDate: row.trade_date ?? undefined,
    extractedSignals: row.extracted_signals ?? undefined,
    exemptFromAutoDeactivation: row.exempt_from_auto_deactivation,
    status: row.status,
  };
}

/** Fetch all tracked strategy videos from DB */
export async function getStrategyVideos(): Promise<StrategyVideoNormalized[]> {
  const { data, error } = await supabase
    .from('strategy_videos')
    .select('*')
    .in('status', ['tracked'])
    .order('tracked_at', { ascending: false });

  if (error) return [];
  return (data ?? []).map((r) => toNormalized(r as StrategyVideoRecord));
}

/** Fetch raw rows for internal use */
export async function getStrategyVideoRows(): Promise<StrategyVideoRecord[]> {
  const { data, error } = await supabase
    .from('strategy_videos')
    .select('*')
    .in('status', ['tracked'])
    .order('tracked_at', { ascending: false });

  if (error) return [];
  return (data ?? []) as StrategyVideoRecord[];
}

/** Get source names exempt from auto-deactivation */
export async function getExemptFromAutoDeactivationSources(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('strategy_videos')
    .select('source_name')
    .eq('exempt_from_auto_deactivation', true)
    .in('status', ['tracked']);

  if (error) return new Set();
  const exempt = new Set<string>();
  for (const row of data ?? []) {
    const name = (row as { source_name: string }).source_name?.trim();
    if (name) exempt.add(name);
  }
  return exempt;
}
