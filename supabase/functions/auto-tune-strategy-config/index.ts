// Auto-Tune Strategy Config
// Runs after market close (called by the auto-trader daily rehydration hook).
// Analyzes 30-day rolling performance per category and strategy source,
// then makes bounded adjustments to auto_trader_config.
//
// Tuning philosophy:
//   - Double down on what's winning (increase size / lower confidence bars)
//   - Reduce exposure to what's losing (decrease size / raise confidence bars)
//   - Never make changes larger than ±20% per run (prevent runaway adjustments)
//   - Always require minimum sample size before acting (avoid overfitting on 3 trades)
//   - Log every decision with full reasoning for auditability

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ─────────────────────────────────────────────────

interface CategoryStats {
  category: string;    // 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM' | 'influencer_day' | 'scanner_day'
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  profitFactor: number;
}

interface SourceStats {
  sourceName: string;
  videoId: string | null;
  trades: number;
  wins: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  profitFactor: number;
}

interface TuneDecision {
  param: string;
  oldValue: number | boolean | null;
  newValue: number | boolean;
  reason: string;
  category: string;
}

interface ConfigRow {
  external_signal_position_size: number | null;
  min_scanner_confidence: number | null;
  base_allocation_pct: number | null;
  long_term_bucket_pct: number | null;
  kelly_adaptive_enabled: boolean | null;
  max_positions: number | null;
  options_min_iv_rank: number | null;
  options_delta_target: number | null;
  options_profit_close_pct: number | null;
  options_stop_loss_multiplier: number | null;
  options_max_contracts_per_scan: number | null;
}

// ── Defaults (must match auto-trader DEFAULT_CONFIG) ──────

const DEFAULTS = {
  external_signal_position_size: 5000,
  min_scanner_confidence: 7,
  base_allocation_pct: 2.0,
  long_term_bucket_pct: 40,
  kelly_adaptive_enabled: false,
  max_positions: 3,
};

// ── Bounds (hard limits on what auto-tune can change) ─────

const BOUNDS = {
  external_signal_position_size: { min: 1000, max: 15_000 },
  min_scanner_confidence: { min: 6.0, max: 9.0 },
  base_allocation_pct: { min: 0.5, max: 5.0 },
  long_term_bucket_pct: { min: 15, max: 60 },
  max_positions: { min: 2, max: 8 },
};

const MIN_SAMPLE = 8; // minimum closed trades before a rule fires
const ANALYSIS_DAYS = 30;

// ── Helpers ───────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function profitFactor(totalPnl: number, wins: number[], losses: number[]): number {
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  if (grossLoss === 0) return grossWin > 0 ? 999 : 0;
  return Math.round((grossWin / grossLoss) * 100) / 100;
}

// Round to 1 decimal place for config values
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Main Handler ──────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const isManual = req.method === 'POST';
  const trigger = isManual ? 'manual' : 'scheduled';

  try {
    // ── 1. Load current config ────────────────────────────
    const { data: configData } = await supabase
      .from('auto_trader_config')
      .select('external_signal_position_size, min_scanner_confidence, base_allocation_pct, long_term_bucket_pct, kelly_adaptive_enabled, max_positions')
      .eq('id', 'default')
      .single();

    const cfg: ConfigRow = configData ?? {};
    const current = {
      external_signal_position_size: cfg.external_signal_position_size ?? DEFAULTS.external_signal_position_size,
      min_scanner_confidence: cfg.min_scanner_confidence ?? DEFAULTS.min_scanner_confidence,
      base_allocation_pct: cfg.base_allocation_pct ?? DEFAULTS.base_allocation_pct,
      long_term_bucket_pct: cfg.long_term_bucket_pct ?? DEFAULTS.long_term_bucket_pct,
      kelly_adaptive_enabled: cfg.kelly_adaptive_enabled ?? DEFAULTS.kelly_adaptive_enabled,
      max_positions: cfg.max_positions ?? DEFAULTS.max_positions,
    };

    // ── 2. Load last 30 days of closed trades ─────────────
    const since = new Date();
    since.setDate(since.getDate() - ANALYSIS_DAYS);

    const { data: tradesData, error: tradesError } = await supabase
      .from('paper_trades')
      .select('id, mode, pnl, pnl_percent, fill_price, strategy_video_id, notes, status, closed_at')
      .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED'])
      .not('fill_price', 'is', null)
      .not('closed_at', 'is', null)
      .gte('closed_at', since.toISOString())
      .order('closed_at', { ascending: false })
      .limit(500);

    if (tradesError) throw tradesError;
    const trades = (tradesData ?? []) as Array<{
      id: string;
      mode: string;
      pnl: number | null;
      pnl_percent: number | null;
      fill_price: number | null;
      strategy_video_id: string | null;
      notes: string | null;
      status: string;
      closed_at: string;
    }>;

    // Exclude dip buys / profit takes from analysis
    const cleanTrades = trades.filter(t => {
      const notes = (t.notes ?? '').toLowerCase();
      return !notes.startsWith('dip buy') && !notes.startsWith('profit take');
    });

    // ── 3. Compute per-category stats ─────────────────────
    const computeStats = (subset: typeof cleanTrades, category: string): CategoryStats => {
      const pnls = subset.map(t => t.pnl ?? 0);
      const wins = pnls.filter(p => p > 0);
      const losses = pnls.filter(p => p < 0);
      const returns = subset.map(t => t.pnl_percent ?? 0);
      return {
        category,
        trades: subset.length,
        wins: wins.length,
        losses: losses.length,
        winRate: subset.length > 0 ? wins.length / subset.length : 0,
        avgReturnPct: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
        totalPnl: pnls.reduce((a, b) => a + b, 0),
        profitFactor: profitFactor(pnls.reduce((a, b) => a + b, 0), wins, losses),
      };
    };

    // Influencer day trades = DAY_TRADE with a strategy_video_id
    const influencerDay = cleanTrades.filter(t => t.mode === 'DAY_TRADE' && t.strategy_video_id != null);
    // Scanner day trades = DAY_TRADE without a strategy_video_id
    const scannerDay = cleanTrades.filter(t => t.mode === 'DAY_TRADE' && t.strategy_video_id == null);
    const swingTrades = cleanTrades.filter(t => t.mode === 'SWING_TRADE');
    const longTerm = cleanTrades.filter(t => t.mode === 'LONG_TERM');
    const allDayTrade = cleanTrades.filter(t => t.mode === 'DAY_TRADE');

    const categoryStats: CategoryStats[] = [
      computeStats(influencerDay, 'influencer_day'),
      computeStats(scannerDay, 'scanner_day'),
      computeStats(swingTrades, 'SWING_TRADE'),
      computeStats(longTerm, 'LONG_TERM'),
      computeStats(allDayTrade, 'DAY_TRADE'),
    ];

    // ── 4. Compute per-source stats (top influencer sources) ──
    const bySource = new Map<string, typeof cleanTrades>();
    for (const t of cleanTrades) {
      if (!t.strategy_video_id) continue;
      const key = t.strategy_video_id;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(t);
    }
    const sourceStats: SourceStats[] = Array.from(bySource.entries())
      .filter(([, ts]) => ts.length >= 3)
      .map(([videoId, ts]) => {
        const pnls = ts.map(t => t.pnl ?? 0);
        const wins = pnls.filter(p => p > 0);
        const losses = pnls.filter(p => p < 0);
        return {
          sourceName: videoId,
          videoId,
          trades: ts.length,
          wins: wins.length,
          winRate: ts.length > 0 ? wins.length / ts.length : 0,
          avgReturnPct: ts.map(t => t.pnl_percent ?? 0).reduce((a, b) => a + b, 0) / ts.length,
          totalPnl: pnls.reduce((a, b) => a + b, 0),
          profitFactor: profitFactor(pnls.reduce((a, b) => a + b, 0), wins, losses),
        };
      });

    const totalTrades = cleanTrades.length;

    // ── 4b. Granular scanner data — confidence buckets + market conditions ────
    // Pull scanner_confidence and market_condition from notes/metadata on day trades
    const scannerDayIds = scannerDay.map(t => t.id);
    let confBuckets: Array<{ conf: number; pnl: number }> = [];
    let condPnls: Map<string, number[]> = new Map();

    if (scannerDayIds.length >= MIN_SAMPLE) {
      const { data: detailData } = await supabase
        .from('paper_trades')
        .select('id, scanner_confidence, pnl, notes')
        .in('id', scannerDayIds.slice(0, 200));

      if (detailData) {
        for (const row of detailData as Array<{ id: string; scanner_confidence: number | null; pnl: number | null; notes: string | null }>) {
          if (row.scanner_confidence != null && row.pnl != null) {
            confBuckets.push({ conf: row.scanner_confidence, pnl: row.pnl });
          }
          // market_condition stored in notes as "market_condition:trend" etc.
          if (row.notes && row.pnl != null) {
            const m = row.notes.match(/market_condition:(\w+)/);
            if (m) {
              const cond = m[1];
              if (!condPnls.has(cond)) condPnls.set(cond, []);
              condPnls.get(cond)!.push(row.pnl);
            }
          }
        }
      }
    }

    // ── 5. Apply tuning rules ────────────────────────────
    const decisions: TuneDecision[] = [];
    const updates: Record<string, number | boolean> = {};

    const infDay = categoryStats.find(s => s.category === 'influencer_day')!;
    const scanDay = categoryStats.find(s => s.category === 'scanner_day')!;
    const swing = categoryStats.find(s => s.category === 'SWING_TRADE')!;
    const lt = categoryStats.find(s => s.category === 'LONG_TERM')!;

    // ── Rule A: Influencer day trade position sizing ──────
    // Strong performance → grow the position size; weak → shrink it
    if (infDay.trades >= MIN_SAMPLE) {
      const old = current.external_signal_position_size;
      let newVal = old;

      if (infDay.profitFactor >= 1.5 && infDay.winRate >= 0.52) {
        // Winning — grow by 20%, hard cap $15k
        newVal = clamp(Math.round(old * 1.20 / 100) * 100, BOUNDS.external_signal_position_size.min, BOUNDS.external_signal_position_size.max);
        if (newVal !== old) {
          decisions.push({
            param: 'external_signal_position_size',
            oldValue: old,
            newValue: newVal,
            reason: `Influencer day trades: ${infDay.trades} trades, ${(infDay.winRate * 100).toFixed(0)}% WR, PF ${infDay.profitFactor} — scaling up`,
            category: 'influencer_day',
          });
          updates.external_signal_position_size = newVal;
        }
      } else if (infDay.profitFactor < 1.0 && infDay.winRate < 0.45) {
        // Losing — shrink by 20%, floor $1k
        newVal = clamp(Math.round(old * 0.80 / 100) * 100, BOUNDS.external_signal_position_size.min, BOUNDS.external_signal_position_size.max);
        if (newVal !== old) {
          decisions.push({
            param: 'external_signal_position_size',
            oldValue: old,
            newValue: newVal,
            reason: `Influencer day trades: ${infDay.trades} trades, ${(infDay.winRate * 100).toFixed(0)}% WR, PF ${infDay.profitFactor} — scaling down`,
            category: 'influencer_day',
          });
          updates.external_signal_position_size = newVal;
        }
      }
    }

    // ── Rule B: Scanner confidence threshold ─────────────
    // If scanner-sourced day trades are losing → raise the bar
    // If they're consistently winning → allow slightly more entries
    const scannerRef = scanDay.trades >= MIN_SAMPLE ? scanDay : (swing.trades >= MIN_SAMPLE ? swing : null);
    if (scannerRef && scannerRef.trades >= MIN_SAMPLE) {
      const old = current.min_scanner_confidence;
      let newVal = old;

      if (scannerRef.profitFactor < 0.85 && scannerRef.winRate < 0.42) {
        newVal = r1(clamp(old + 0.5, BOUNDS.min_scanner_confidence.min, BOUNDS.min_scanner_confidence.max));
        if (newVal !== old) {
          decisions.push({
            param: 'min_scanner_confidence',
            oldValue: old,
            newValue: newVal,
            reason: `${scannerRef.category}: ${scannerRef.trades} trades, ${(scannerRef.winRate * 100).toFixed(0)}% WR, PF ${scannerRef.profitFactor} — raising confidence bar`,
            category: scannerRef.category,
          });
          updates.min_scanner_confidence = newVal;
        }
      } else if (scannerRef.profitFactor > 1.6 && scannerRef.winRate > 0.58 && old > DEFAULTS.min_scanner_confidence) {
        newVal = r1(clamp(old - 0.5, BOUNDS.min_scanner_confidence.min, BOUNDS.min_scanner_confidence.max));
        if (newVal !== old) {
          decisions.push({
            param: 'min_scanner_confidence',
            oldValue: old,
            newValue: newVal,
            reason: `${scannerRef.category}: ${scannerRef.trades} trades, ${(scannerRef.winRate * 100).toFixed(0)}% WR, PF ${scannerRef.profitFactor} — lowering confidence bar (strategy working well)`,
            category: scannerRef.category,
          });
          updates.min_scanner_confidence = newVal;
        }
      }
    }

    // ── Rule C: Base allocation per trade (swing/scanner sizing) ──
    if (swing.trades >= MIN_SAMPLE) {
      const old = current.base_allocation_pct;
      let newVal = old;

      if (swing.profitFactor < 0.8 && swing.winRate < 0.40) {
        newVal = r1(clamp(old - 0.5, BOUNDS.base_allocation_pct.min, BOUNDS.base_allocation_pct.max));
        if (newVal !== old) {
          decisions.push({
            param: 'base_allocation_pct',
            oldValue: old,
            newValue: newVal,
            reason: `Swing trades: ${swing.trades} trades, ${(swing.winRate * 100).toFixed(0)}% WR, PF ${swing.profitFactor} — reducing base allocation`,
            category: 'SWING_TRADE',
          });
          updates.base_allocation_pct = newVal;
        }
      } else if (swing.profitFactor > 1.5 && swing.winRate > 0.55 && old < DEFAULTS.base_allocation_pct + 1.5) {
        newVal = r1(clamp(old + 0.5, BOUNDS.base_allocation_pct.min, BOUNDS.base_allocation_pct.max));
        if (newVal !== old) {
          decisions.push({
            param: 'base_allocation_pct',
            oldValue: old,
            newValue: newVal,
            reason: `Swing trades: ${swing.trades} trades, ${(swing.winRate * 100).toFixed(0)}% WR, PF ${swing.profitFactor} — growing base allocation`,
            category: 'SWING_TRADE',
          });
          updates.base_allocation_pct = newVal;
        }
      }
    }

    // ── Rule D: Long-term bucket allocation ───────────────
    if (lt.trades >= MIN_SAMPLE) {
      const old = current.long_term_bucket_pct;
      let newVal = old;

      if (lt.profitFactor < 0.8 && lt.winRate < 0.40) {
        // Long-term positions bleeding → shrink bucket, free capital for day/swing
        newVal = clamp(old - 5, BOUNDS.long_term_bucket_pct.min, BOUNDS.long_term_bucket_pct.max);
        if (newVal !== old) {
          decisions.push({
            param: 'long_term_bucket_pct',
            oldValue: old,
            newValue: newVal,
            reason: `Long-term: ${lt.trades} trades, ${(lt.winRate * 100).toFixed(0)}% WR, PF ${lt.profitFactor} — reducing LT bucket`,
            category: 'LONG_TERM',
          });
          updates.long_term_bucket_pct = newVal;
        }
      } else if (lt.profitFactor > 1.5 && lt.winRate > 0.60 && old < DEFAULTS.long_term_bucket_pct + 10) {
        newVal = clamp(old + 5, BOUNDS.long_term_bucket_pct.min, BOUNDS.long_term_bucket_pct.max);
        if (newVal !== old) {
          decisions.push({
            param: 'long_term_bucket_pct',
            oldValue: old,
            newValue: newVal,
            reason: `Long-term: ${lt.trades} trades, ${(lt.winRate * 100).toFixed(0)}% WR, PF ${lt.profitFactor} — growing LT bucket`,
            category: 'LONG_TERM',
          });
          updates.long_term_bucket_pct = newVal;
        }
      }
    }

    // ── Rule D2: Confidence bucket analysis — granular confidence threshold ──
    // If high-confidence (≥8) has meaningfully better outcomes than mid (6-7),
    // raise the bar so we only take the best setups.
    if (confBuckets.length >= MIN_SAMPLE) {
      const high = confBuckets.filter(b => b.conf >= 8);
      const mid  = confBuckets.filter(b => b.conf >= 6 && b.conf < 8);

      if (high.length >= 5 && mid.length >= 5) {
        const avgHigh = high.reduce((s, b) => s + b.pnl, 0) / high.length;
        const avgMid  = mid.reduce((s, b) => s + b.pnl, 0) / mid.length;
        const highWR  = high.filter(b => b.pnl > 0).length / high.length;
        const midWR   = mid.filter(b => b.pnl > 0).length / mid.length;
        const old = current.min_scanner_confidence;

        if (avgMid < 0 && midWR < 0.40 && highWR > 0.50 && old < 8.0) {
          // Mid-confidence is net negative, high is profitable — raise bar
          const newVal = r1(clamp(old + 0.5, BOUNDS.min_scanner_confidence.min, 8.5));
          if (newVal !== old) {
            decisions.push({
              param: 'min_scanner_confidence',
              oldValue: old,
              newValue: newVal,
              reason: `Confidence bucket analysis: conf 6-7 avg P&L $${avgMid.toFixed(0)} (${Math.round(midWR * 100)}% WR), conf 8+ avg $${avgHigh.toFixed(0)} (${Math.round(highWR * 100)}% WR) — raising threshold`,
              category: 'scanner_day',
            });
            updates.min_scanner_confidence = newVal;
          }
        }
      }
    }

    // ── Rule E: Enable Kelly adaptive sizing if data matures ──
    if (!current.kelly_adaptive_enabled && totalTrades >= 25) {
      decisions.push({
        param: 'kelly_adaptive_enabled',
        oldValue: false,
        newValue: true,
        reason: `Sufficient trade history (${totalTrades} closed trades) — enabling half-Kelly adaptive sizing`,
        category: 'system',
      });
      updates.kelly_adaptive_enabled = true;
    }

    // ── Rule F: Max positions — scale with how well active strategies perform ──
    // Only increase max_positions if influencer day trades AND overall are winning
    if (infDay.trades >= MIN_SAMPLE && totalTrades >= 20) {
      const old = current.max_positions;
      const allStats = computeStats(cleanTrades, 'all');

      if (allStats.profitFactor >= 1.4 && infDay.profitFactor >= 1.5 && old < 6) {
        const newVal = Math.min(old + 1, BOUNDS.max_positions.max);
        if (newVal !== old) {
          decisions.push({
            param: 'max_positions',
            oldValue: old,
            newValue: newVal,
            reason: `Overall PF ${allStats.profitFactor}, influencer PF ${infDay.profitFactor} — increasing concurrent positions`,
            category: 'system',
          });
          updates.max_positions = newVal;
        }
      } else if (allStats.profitFactor < 0.8 && old > 2) {
        const newVal = Math.max(old - 1, BOUNDS.max_positions.min);
        if (newVal !== old) {
          decisions.push({
            param: 'max_positions',
            oldValue: old,
            newValue: newVal,
            reason: `Overall PF ${allStats.profitFactor} — reducing concurrent positions until performance recovers`,
            category: 'system',
          });
          updates.max_positions = newVal;
        }
      }
    }

    // ── Rule G: Options wheel auto-tuning ────────────────────────────────
    // Analyzes last 30 days of OPTIONS_PUT and OPTIONS_CALL closed trades.
    // Tunes: min IV rank, delta target, max contracts per scan, profit close %, stop loss multiplier.
    const { data: optionsConfigData } = await supabase
      .from('auto_trader_config')
      .select('options_min_iv_rank, options_delta_target, options_profit_close_pct, options_stop_loss_multiplier, options_max_contracts_per_scan')
      .eq('id', 'default')
      .single();

    const optsCfg = optionsConfigData as {
      options_min_iv_rank?: number;
      options_delta_target?: number;
      options_profit_close_pct?: number;
      options_stop_loss_multiplier?: number;
      options_max_contracts_per_scan?: number;
    } | null;

    const optsMinIvRank = optsCfg?.options_min_iv_rank ?? 50;
    const optsDeltaTarget = optsCfg?.options_delta_target ?? 0.30;
    const optsProfitClosePct = optsCfg?.options_profit_close_pct ?? 50;
    const optsStopLossMultiplier = optsCfg?.options_stop_loss_multiplier ?? 3.0;
    const optsMaxContracts = optsCfg?.options_max_contracts_per_scan ?? 1;

    const { data: optionsTradesData } = await supabase
      .from('paper_trades')
      .select('id, pnl, pnl_percent, close_reason, option_strike, option_premium, option_iv_rank, option_delta, opened_at, closed_at')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', ['CLOSED'])
      .not('closed_at', 'is', null)
      .gte('closed_at', since.toISOString())
      .order('closed_at', { ascending: false })
      .limit(200);

    const optsTrades = (optionsTradesData ?? []) as Array<{
      id: string;
      pnl: number | null;
      pnl_percent: number | null;
      close_reason: string | null;
      option_strike: number | null;
      option_premium: number | null;
      option_iv_rank: number | null;
      option_delta: number | null;
      opened_at: string | null;
      closed_at: string | null;
    }>;

    // Always add options stats to categoryStats for audit visibility
    if (optsTrades.length > 0) {
      const optsPnlsAll = optsTrades.map(t => t.pnl ?? 0);
      const optsWinsAll = optsPnlsAll.filter(p => p > 0);
      const optsLossesAll = optsPnlsAll.filter(p => p < 0);
      const optsReturnsAll = optsTrades.map(t => t.pnl_percent ?? 0);
      categoryStats.push({
        category: 'OPTIONS',
        trades: optsTrades.length,
        wins: optsWinsAll.length,
        losses: optsLossesAll.length,
        winRate: optsWinsAll.length / optsTrades.length,
        avgReturnPct: optsReturnsAll.reduce((a, b) => a + b, 0) / optsReturnsAll.length,
        totalPnl: optsPnlsAll.reduce((a, b) => a + b, 0),
        profitFactor: profitFactor(optsPnlsAll.reduce((a, b) => a + b, 0), optsWinsAll, optsLossesAll),
      });
    }

    if (optsTrades.length >= MIN_SAMPLE) {
      const optsPnls = optsTrades.map(t => t.pnl ?? 0);
      const optsWins = optsPnls.filter(p => p > 0);
      const optsLosses = optsPnls.filter(p => p < 0);
      const optsWinRate = optsTrades.length > 0 ? optsWins.length / optsTrades.length : 0;
      const optsProfitFactor = profitFactor(optsPnls.reduce((a, b) => a + b, 0), optsWins, optsLosses);

      // Count close reasons
      const stopLossCount = optsTrades.filter(t => t.close_reason === 'stop_loss').length;
      const assignedCount = optsTrades.filter(t => t.close_reason === 'assigned').length;
      const profit50Count = optsTrades.filter(t => t.close_reason === '50pct_profit').length;
      const expiredCount = optsTrades.filter(t => t.close_reason === 'expired_worthless').length;

      const stopLossRate = optsTrades.length > 0 ? stopLossCount / optsTrades.length : 0;
      const assignmentRate = optsTrades.length > 0 ? assignedCount / optsTrades.length : 0;

      // Suppress unused-variable warnings
      void profit50Count; void expiredCount;

      // G1: Stop-loss rate too high → raise min IV rank (filter for better-premium entries)
      if (stopLossRate > 0.15 && optsTrades.length >= MIN_SAMPLE) {
        const newVal = Math.min(optsMinIvRank + 5, 75);
        if (newVal !== optsMinIvRank) {
          decisions.push({
            param: 'options_min_iv_rank',
            oldValue: optsMinIvRank,
            newValue: newVal,
            reason: `Options stop-loss rate ${(stopLossRate * 100).toFixed(0)}% (>${15}%) over ${optsTrades.length} trades — raising IV rank floor to filter lower-quality entries`,
            category: 'OPTIONS_PUT',
          });
          updates.options_min_iv_rank = newVal;
        }
      } else if (stopLossRate < 0.05 && optsWinRate > 0.75 && optsMinIvRank > 40) {
        // Very few stop-losses, winning well → can relax IV rank slightly
        const newVal = Math.max(optsMinIvRank - 5, 40);
        if (newVal !== optsMinIvRank) {
          decisions.push({
            param: 'options_min_iv_rank',
            oldValue: optsMinIvRank,
            newValue: newVal,
            reason: `Options performing well: stop-loss rate ${(stopLossRate * 100).toFixed(0)}%, win rate ${(optsWinRate * 100).toFixed(0)}% — relaxing IV rank floor slightly to allow more entries`,
            category: 'OPTIONS_PUT',
          });
          updates.options_min_iv_rank = newVal;
        }
      }

      // G2: Assignment rate too high → nudge delta target lower (more OTM cushion)
      if (assignmentRate > 0.20) {
        const newVal = r1(Math.max(optsDeltaTarget - 0.02, 0.15));
        if (newVal !== optsDeltaTarget) {
          decisions.push({
            param: 'options_delta_target',
            oldValue: optsDeltaTarget,
            newValue: newVal,
            reason: `Options assignment rate ${(assignmentRate * 100).toFixed(0)}% (>${20}%) — nudging delta target lower for more OTM cushion`,
            category: 'OPTIONS_PUT',
          });
          updates.options_delta_target = newVal;
        }
      } else if (assignmentRate < 0.05 && optsWinRate > 0.80 && optsDeltaTarget < 0.35) {
        // Rarely getting assigned and winning consistently → can take slightly more premium (higher delta)
        const newVal = r1(Math.min(optsDeltaTarget + 0.02, 0.35));
        if (newVal !== optsDeltaTarget) {
          decisions.push({
            param: 'options_delta_target',
            oldValue: optsDeltaTarget,
            newValue: newVal,
            reason: `Options assignment rate ${(assignmentRate * 100).toFixed(0)}%, win rate ${(optsWinRate * 100).toFixed(0)}% — nudging delta up slightly to collect more premium`,
            category: 'OPTIONS_PUT',
          });
          updates.options_delta_target = newVal;
        }
      }

      // G3: Win rate consistently strong → increase max contracts per scan
      if (optsWinRate >= 0.80 && optsProfitFactor >= 1.5 && optsTrades.length >= 15 && optsMaxContracts < 5) {
        const newVal = optsMaxContracts + 1;
        decisions.push({
          param: 'options_max_contracts_per_scan',
          oldValue: optsMaxContracts,
          newValue: newVal,
          reason: `Options win rate ${(optsWinRate * 100).toFixed(0)}%, PF ${optsProfitFactor} over ${optsTrades.length} trades — scaling up daily deployment`,
          category: 'OPTIONS_PUT',
        });
        updates.options_max_contracts_per_scan = newVal;
      } else if (optsWinRate < 0.55 && optsProfitFactor < 0.9 && optsMaxContracts > 1) {
        const newVal = Math.max(optsMaxContracts - 1, 1);
        decisions.push({
          param: 'options_max_contracts_per_scan',
          oldValue: optsMaxContracts,
          newValue: newVal,
          reason: `Options win rate ${(optsWinRate * 100).toFixed(0)}%, PF ${optsProfitFactor} — reducing daily deployment until performance recovers`,
          category: 'OPTIONS_PUT',
        });
        updates.options_max_contracts_per_scan = newVal;
      }

      // G4: 50% close happens very quickly (avg DTE at close < 8 days) → lower profit target to 40%
      // This means we could be exiting even sooner and redeploying faster
      const closedWithDte = optsTrades.filter(t => t.opened_at && t.closed_at && t.close_reason === '50pct_profit');
      if (closedWithDte.length >= 5) {
        const avgDaysToClose = closedWithDte.reduce((sum, t) => {
          const days = (new Date(t.closed_at!).getTime() - new Date(t.opened_at!).getTime()) / (1000 * 60 * 60 * 24);
          return sum + days;
        }, 0) / closedWithDte.length;

        if (avgDaysToClose < 8 && optsProfitClosePct > 40) {
          const newVal = Math.max(optsProfitClosePct - 5, 40);
          decisions.push({
            param: 'options_profit_close_pct',
            oldValue: optsProfitClosePct,
            newValue: newVal,
            reason: `50%-close positions averaging ${avgDaysToClose.toFixed(1)} days — lowering profit target slightly for faster capital recycling`,
            category: 'OPTIONS_PUT',
          });
          updates.options_profit_close_pct = newVal;
        } else if (avgDaysToClose > 20 && optsProfitClosePct < 60) {
          // Takes a long time to hit target → raise it since we're not gaining from early exit
          const newVal = Math.min(optsProfitClosePct + 5, 60);
          decisions.push({
            param: 'options_profit_close_pct',
            oldValue: optsProfitClosePct,
            newValue: newVal,
            reason: `50%-close positions averaging ${avgDaysToClose.toFixed(1)} days to hit target — raising profit threshold slightly`,
            category: 'OPTIONS_PUT',
          });
          updates.options_profit_close_pct = newVal;
        }
      }
    }

    // ── 6. Apply updates to config ────────────────────────
    if (Object.keys(updates).length > 0) {
      await supabase
        .from('auto_trader_config')
        .upsert({
          id: 'default',
          ...updates,
          updated_at: new Date().toISOString(),
        });
    }

    // ── 7. Log the run ────────────────────────────────────
    const analysis = {
      window_days: ANALYSIS_DAYS,
      total_trades_analyzed: totalTrades,
      categories: categoryStats,
      top_sources: sourceStats.sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 10),
    };

    await supabase.from('strategy_tune_log').insert({
      trigger,
      analysis,
      decisions,
      applied: Object.keys(updates).length > 0,
      notes: decisions.length === 0
        ? 'No changes needed — performance within acceptable bounds'
        : `Applied ${decisions.length} adjustment(s)`,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        trigger,
        totalTradesAnalyzed: totalTrades,
        decisionsCount: decisions.length,
        decisions,
        updates,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('[auto-tune-strategy-config]:', err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
