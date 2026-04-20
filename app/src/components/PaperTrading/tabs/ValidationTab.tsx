import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Brain, TrendingUp, TrendingDown, Minus, CheckCircle, AlertCircle, Clock, PlayCircle } from 'lucide-react';
import type { DayTradeValidationReport, SwingTradeValidationReport, TuneLogEntry } from '../../../lib/paperTradesApi';
import { getStrategyTuneLogs, triggerAutoTune } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';
import { Spinner } from '../../Spinner';

export interface ValidationTabProps {
  dayReport: DayTradeValidationReport | null;
  swingReport: SwingTradeValidationReport | null;
  onRefresh: () => void;
}

const PARAM_LABELS: Record<string, string> = {
  min_scanner_confidence:       'Min Scanner Confidence',
  external_signal_position_size:'Influencer Position Size ($)',
  base_allocation_pct:          'Base Allocation per Trade (%)',
  long_term_bucket_pct:         'Long-Term Bucket (%)',
  kelly_adaptive_enabled:       'Kelly Adaptive Sizing',
  max_positions:                'Max Concurrent Positions',
};

function DecisionBadge({ param, oldVal, newVal }: { param: string; oldVal: unknown; newVal: unknown }) {
  const label = PARAM_LABELS[param] ?? param;
  const up = typeof newVal === 'number' && typeof oldVal === 'number' && newVal > oldVal;
  const down = typeof newVal === 'number' && typeof oldVal === 'number' && newVal < oldVal;
  const toggle = typeof newVal === 'boolean';

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-[hsl(var(--border))] bg-white">
      <div className={`mt-0.5 flex-shrink-0 ${up ? 'text-emerald-500' : down ? 'text-red-500' : 'text-blue-500'}`}>
        {up ? <TrendingUp className="w-4 h-4" /> : down ? <TrendingDown className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          {toggle
            ? `${String(oldVal)} → ${String(newVal)}`
            : `${oldVal} → ${newVal}`}
        </p>
      </div>
    </div>
  );
}

function TuneRunCard({ entry }: { entry: TuneLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const age = Math.round((Date.now() - new Date(entry.created_at).getTime()) / 3_600_000);
  const ageLabel = age < 1 ? 'just now' : age < 24 ? `${age}h ago` : `${Math.floor(age / 24)}d ago`;

  return (
    <div className={`rounded-xl border overflow-hidden ${entry.applied && entry.decisions.length > 0 ? 'border-blue-200 bg-blue-50/30' : 'border-[hsl(var(--border))] bg-white'}`}>
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-black/5 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          {entry.applied && entry.decisions.length > 0
            ? <CheckCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
            : <Clock className="w-4 h-4 text-[hsl(var(--muted-foreground))] flex-shrink-0" />}
          <div>
            <p className="text-sm font-medium">
              {entry.decisions.length > 0 ? `${entry.decisions.length} adjustment${entry.decisions.length > 1 ? 's' : ''} applied` : 'No changes — within bounds'}
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {ageLabel} · {entry.trigger} · {entry.analysis.total_trades_analyzed} trades analyzed
            </p>
          </div>
        </div>
        <span className="text-xs text-[hsl(var(--muted-foreground))]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-[hsl(var(--border))]">
          {entry.decisions.length > 0 ? (
            <>
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] pt-3">Parameter changes</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {entry.decisions.map((d, i) => (
                  <DecisionBadge key={i} param={d.param} oldVal={d.oldValue} newVal={d.newValue} />
                ))}
              </div>
              <div className="space-y-1.5 pt-1">
                <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Reasoning</p>
                {entry.decisions.map((d, i) => (
                  <p key={i} className="text-xs text-[hsl(var(--muted-foreground))] leading-relaxed">
                    <span className="font-medium text-foreground">{PARAM_LABELS[d.param] ?? d.param}:</span> {d.reason}
                  </p>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-[hsl(var(--muted-foreground))] pt-3">{entry.notes}</p>
          )}

          <div className="pt-2 border-t border-[hsl(var(--border))]">
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-2">30-day category snapshot</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {entry.analysis.categories
                .filter(c => c.trades > 0)
                .map(c => (
                  <div key={c.category} className="rounded-lg border border-[hsl(var(--border))] bg-white p-2.5">
                    <p className="text-xs text-[hsl(var(--muted-foreground))] capitalize mb-1">
                      {c.category.replace(/_/g, ' ').toLowerCase()}
                    </p>
                    <p className="text-sm font-bold tabular-nums">{c.trades} trades</p>
                    <p className={`text-xs ${c.winRate >= 0.5 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {Math.round(c.winRate * 100)}% WR · PF {c.profitFactor}
                    </p>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticsSection({
  dayReport,
  swingReport,
}: {
  dayReport: DayTradeValidationReport | null;
  swingReport: SwingTradeValidationReport | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[hsl(var(--secondary))] transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-sm font-semibold">Raw Diagnostics (trend vs chop, confidence, InPlay)</span>
        <span className="text-xs text-[hsl(var(--muted-foreground))]">{open ? '▲ hide' : '▼ show'}</span>
      </button>

      {open && (
        <div className="border-t border-[hsl(var(--border))] p-4 space-y-6">

          {/* Day — trend vs chop */}
          {dayReport?.trendVsChop && dayReport.trendVsChop.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-2">Day — Trend vs Chop</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {dayReport.trendVsChop.map(row => (
                  <div key={row.marketCondition} className="rounded-lg border border-[hsl(var(--border))] p-3">
                    <p className="text-xs capitalize text-[hsl(var(--muted-foreground))]">{row.marketCondition}</p>
                    <p className="text-lg font-bold">{row.trades}</p>
                    <p className={`text-xs ${row.winRatePct >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>{row.winRatePct}% WR</p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">Avg R {row.avgRMultiple} · {fmtUsd(row.avgPnl, 2, true)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Day — confidence buckets */}
          {dayReport?.confidence7Plus && dayReport.confidence7Plus.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-2">Day — Confidence Buckets</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {dayReport.confidence7Plus.map(row => (
                  <div key={row.confBucket} className="rounded-lg border border-[hsl(var(--border))] p-3">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{row.confBucket}</p>
                    <p className="text-lg font-bold">{row.trades}</p>
                    <p className={`text-xs ${row.winRatePct >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>{row.winRatePct}% WR</p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">Avg R {row.avgRMultiple}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Day — InPlayScore */}
          {dayReport?.inPlayScoreBuckets && dayReport.inPlayScoreBuckets.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-2">Day — InPlay Score vs Outcome</p>
              <div className="grid grid-cols-3 gap-3">
                {dayReport.inPlayScoreBuckets.map(row => (
                  <div key={row.bucket} className="rounded-lg border border-[hsl(var(--border))] p-3">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{row.bucket}</p>
                    <p className="text-lg font-bold">{row.trades}</p>
                    <p className="text-xs">{row.winRatePct}% WR · Avg R {row.avgRMultiple}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Swing funnel */}
          {swingReport && swingReport.funnel.signals > 0 && (
            <div>
              <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-2">
                Swing — Signal Funnel (last 21d · {swingReport.funnel.signalsPerWeek}/wk)
              </p>
              <div className="grid grid-cols-3 md:grid-cols-7 gap-2 text-sm">
                {[
                  { label: 'Signals', val: swingReport.funnel.signals },
                  { label: 'Conf ≥7', val: swingReport.funnel.confident },
                  { label: 'Skipped', val: swingReport.funnel.skippedDistance },
                  { label: 'Placed', val: swingReport.funnel.ordersPlaced },
                  { label: 'Expired', val: swingReport.funnel.ordersExpired },
                  { label: 'Filled', val: swingReport.funnel.ordersFilled },
                  { label: 'Fill %', val: `${swingReport.fillRate}%` },
                ].map(({ label, val }) => (
                  <div key={label} className="rounded-lg border border-[hsl(var(--border))] p-2.5 text-center">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
                    <p className="text-lg font-bold">{val}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!dayReport && !swingReport && (
            <p className="text-sm text-[hsl(var(--muted-foreground))] text-center py-4">
              No validation data yet. Run trades for 10–20 days to see diagnostics.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ValidationTab({ dayReport, swingReport, onRefresh }: ValidationTabProps) {
  const [logs, setLogs] = useState<TuneLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [tuning, setTuning] = useState(false);
  const [tuneMsg, setTuneMsg] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    const data = await getStrategyTuneLogs(5).catch(() => []);
    setLogs(data);
    setLogsLoading(false);
  }, []);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const handleTune = async () => {
    setTuning(true);
    setTuneMsg(null);
    try {
      const result = await triggerAutoTune();
      if (result.ok) {
        setTuneMsg(result.decisionsCount > 0
          ? `✓ ${result.decisionsCount} adjustment${result.decisionsCount > 1 ? 's' : ''} applied`
          : '✓ No changes needed — all metrics within bounds');
        await loadLogs();
        onRefresh();
      } else {
        setTuneMsg(`Error: ${result.error ?? 'Auto-tune failed'}`);
      }
    } catch (err) {
      setTuneMsg(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setTuning(false);
    }
  };

  const lastRun = logs[0];
  const nextRunLabel = 'Runs automatically after market close each day';

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-blue-500" />
          <div>
            <h2 className="text-base font-semibold">System Learning</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Analyzes your last 30 days of closed trades and adjusts scanner confidence, position sizing, and allocation thresholds automatically.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {tuneMsg && (
            <span className={`text-xs px-2 py-1 rounded-full ${tuneMsg.startsWith('✓') ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
              {tuneMsg}
            </span>
          )}
          <button
            onClick={handleTune}
            disabled={tuning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {tuning ? <Spinner size="sm" /> : <PlayCircle className="w-4 h-4" />}
            Run Now
          </button>
          <button
            onClick={() => { loadLogs(); onRefresh(); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))] text-sm"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Status banner */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4 flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-40">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">Last run</p>
          <p className="text-sm font-medium">
            {lastRun
              ? new Date(lastRun.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
              : 'Never'}
          </p>
          {lastRun && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {lastRun.decisions.length > 0 ? `${lastRun.decisions.length} change${lastRun.decisions.length > 1 ? 's' : ''}` : 'No changes'}
            </p>
          )}
        </div>
        <div className="flex-1 min-w-40">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">Next run</p>
          <p className="text-sm font-medium">{nextRunLabel}</p>
        </div>
        <div className="flex-1 min-w-40">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">What it tunes</p>
          <p className="text-sm font-medium">6 config parameters</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">confidence · sizing · allocation</p>
        </div>
        <div className="flex-1 min-w-40">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">Safety bounds</p>
          <p className="text-sm font-medium">±20% max per run</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">Min 8 trades before any rule fires</p>
        </div>
      </div>

      {/* What the system learns */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
          <h3 className="text-sm font-semibold">What the system learns from your trades</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-[hsl(var(--border))]">
          {[
            {
              icon: <TrendingUp className="w-4 h-4 text-emerald-500" />,
              title: 'Winning strategy → scale up',
              desc: 'If influencer day trades hit profit factor ≥1.5 + 52% WR, position size grows by 20%. If scanner wins consistently, confidence bar lowers to let more trades through.',
            },
            {
              icon: <TrendingDown className="w-4 h-4 text-red-500" />,
              title: 'Losing strategy → reduce exposure',
              desc: 'If scanner day trades fall below 42% WR + PF 0.85, minimum confidence raised. If long-term (Suggested Finds) bleeds, the long-term allocation bucket shrinks.',
            },
            {
              icon: <AlertCircle className="w-4 h-4 text-blue-500" />,
              title: 'Matures over time → Kelly sizing',
              desc: 'After 25+ closed trades, Kelly adaptive sizing is automatically enabled — position sizes scale with your actual edge instead of flat percentages.',
            },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="p-4">
              <div className="flex items-center gap-2 mb-1.5">{icon}<p className="text-sm font-medium">{title}</p></div>
              <p className="text-xs text-[hsl(var(--muted-foreground))] leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tune log history */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Auto-tune history</h3>
        {logsLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : logs.length === 0 ? (
          <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            No auto-tune runs yet. Click <strong>Run Now</strong> or wait for the automatic after-close run tonight.
          </div>
        ) : (
          <div className="space-y-2">
            {logs.map(entry => <TuneRunCard key={entry.id} entry={entry} />)}
          </div>
        )}
      </div>

      {/* Raw diagnostics — collapsible */}
      <DiagnosticsSection dayReport={dayReport} swingReport={swingReport} />

    </div>
  );
}
