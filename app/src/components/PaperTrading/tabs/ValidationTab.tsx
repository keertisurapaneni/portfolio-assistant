import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DayTradeValidationReport, SwingTradeValidationReport } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';

export interface ValidationTabProps {
  dayReport: DayTradeValidationReport | null;
  swingReport: SwingTradeValidationReport | null;
  onRefresh: () => void;
}

function DayTradeValidationTab({ report }: { report: DayTradeValidationReport | null }) {
  if (!report) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center text-[hsl(var(--muted-foreground))]">
        No validation data yet. Run day trades for 10–20 days to see results.
      </div>
    );
  }

  const hasData = report.trendVsChop.length > 0 || report.confidence7Plus.length > 0 || report.recentTrades.length > 0;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Day Trade Validation (10–20 day analysis)</h2>

      {!hasData ? (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center text-[hsl(var(--muted-foreground))]">
          No closed day trades with validation data yet. Trades need entry_trigger_type=bracket_limit.
        </div>
      ) : (
        <>
          {report.trendVsChop.length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Are large-cap trend days working? Chop days killing it?</h3>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {report.trendVsChop.map(row => (
                    <div key={row.marketCondition} className="rounded-lg border border-[hsl(var(--border))] p-4">
                      <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] capitalize">{row.marketCondition}</p>
                      <p className="text-2xl font-bold tabular-nums">{row.trades} trades</p>
                      <p className={`text-sm ${row.winRatePct >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                        Win rate: {row.winRatePct}%
                      </p>
                      <p className="text-sm text-[hsl(var(--muted-foreground))]">
                        Avg R: {row.avgRMultiple} · Avg P&L: {fmtUsd(row.avgPnl, 2, true)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {report.confidence7Plus.length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Is confidence ≥7 actually predictive?</h3>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {report.confidence7Plus.map(row => (
                    <div key={row.confBucket} className="rounded-lg border border-[hsl(var(--border))] p-4">
                      <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{row.confBucket}</p>
                      <p className="text-2xl font-bold tabular-nums">{row.trades} trades</p>
                      <p className={`text-sm ${row.winRatePct >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                        Win rate: {row.winRatePct}%
                      </p>
                      <p className="text-sm text-[hsl(var(--muted-foreground))]">Avg R: {row.avgRMultiple}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {report.inPlayScoreBuckets.length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">InPlayScore vs outcome</h3>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-3 gap-4">
                  {report.inPlayScoreBuckets.map(row => (
                    <div key={row.bucket} className="rounded-lg border border-[hsl(var(--border))] p-4">
                      <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{row.bucket}</p>
                      <p className="text-xl font-bold tabular-nums">{row.trades} trades</p>
                      <p className="text-sm">Win rate: {row.winRatePct}% · Avg R: {row.avgRMultiple}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {report.recentTrades.length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Recent day trades (validation log)</h3>
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[hsl(var(--secondary))]">
                    <tr className="border-b border-[hsl(var(--border))]">
                      <th className="px-4 py-2 text-left font-medium">Ticker</th>
                      <th className="px-4 py-2 text-left font-medium">Entry</th>
                      <th className="px-4 py-2 text-right font-medium">InPlay</th>
                      <th className="px-4 py-2 text-right font-medium">P1</th>
                      <th className="px-4 py-2 text-right font-medium">P2</th>
                      <th className="px-4 py-2 text-left font-medium">Cond</th>
                      <th className="px-4 py-2 text-right font-medium">R</th>
                      <th className="px-4 py-2 text-right font-medium">P&L</th>
                      <th className="px-4 py-2 text-left font-medium">Close</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recentTrades.map((t, i) => (
                      <tr key={i} className="border-b border-[hsl(var(--border))]/50 hover:bg-[hsl(var(--secondary))]/30">
                        <td className="px-4 py-2 font-medium">{t.ticker}</td>
                        <td className="px-4 py-2 text-[hsl(var(--muted-foreground))]">
                          {new Date(t.openedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.inPlayScore ?? '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.pass1Confidence ?? '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.pass2Confidence ?? '—'}</td>
                        <td className="px-4 py-2 text-[hsl(var(--muted-foreground))] capitalize">{t.marketCondition ?? '—'}</td>
                        <td className={`px-4 py-2 text-right tabular-nums font-medium ${(t.rMultiple ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {t.rMultiple != null ? t.rMultiple : '—'}
                        </td>
                        <td className={`px-4 py-2 text-right tabular-nums font-medium ${(t.pnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {t.pnl != null ? fmtUsd(t.pnl, 2, true) : '—'}
                        </td>
                        <td className="px-4 py-2 text-[hsl(var(--muted-foreground))]">{t.closeReason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SwingTradeValidationTab({ report, onRefresh: _onRefresh }: {
  report: SwingTradeValidationReport | null;
  onRefresh: () => void;
}) {
  if (!report) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center text-[hsl(var(--muted-foreground))]">
        Loading swing validation…
      </div>
    );
  }

  const { funnel, trendVsChop, closeReason, quickStops, fillRate, verdict, recentTrades } = report;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Swing Trade Validation (2–3 week analysis)</h2>

      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
          <h3 className="text-sm font-semibold">Funnel (last 21 days) · Signals per week: {funnel.signalsPerWeek}</h3>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-2 md:grid-cols-7 gap-4 text-sm">
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Signals</p>
              <p className="text-xl font-bold tabular-nums">{funnel.signals}</p>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Conf ≥7</p>
              <p className="text-xl font-bold tabular-nums">{funnel.confident}</p>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Skipped (4%)</p>
              <p className="text-xl font-bold tabular-nums">{funnel.skippedDistance}</p>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Placed</p>
              <p className="text-xl font-bold tabular-nums">{funnel.ordersPlaced}</p>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Expired</p>
              <p className="text-xl font-bold tabular-nums">{funnel.ordersExpired}</p>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Filled</p>
              <p className="text-xl font-bold tabular-nums">{funnel.ordersFilled}</p>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Fill rate</p>
              <p className="text-xl font-bold tabular-nums">{fillRate}%</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
        <h3 className="text-sm font-semibold mb-2">Verdict (next upgrade)</h3>
        <p className="text-[hsl(var(--muted-foreground))]">{verdict}</p>
      </div>

      {trendVsChop.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold">Chop vs Trend</h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {trendVsChop.map(row => (
                <div key={row.marketCondition} className="rounded-lg border border-[hsl(var(--border))] p-4">
                  <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] capitalize">{row.marketCondition}</p>
                  <p className="text-2xl font-bold tabular-nums">{row.trades} trades</p>
                  <p className={`text-sm ${row.winRatePct >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>Win rate: {row.winRatePct}%</p>
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">Avg P&L: {fmtUsd(row.avgPnl, 2, true)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {closeReason.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold">Close reason · Quick stops (&lt;2 days): {quickStops.count} ({fmtUsd(quickStops.pnl, 2, true)}, {quickStops.pctOfLosses}% of losses)</h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {closeReason.map(row => (
                <div key={row.reason} className="rounded-lg border border-[hsl(var(--border))] p-4">
                  <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{row.reason}</p>
                  <p className="text-xl font-bold tabular-nums">{row.trades} trades</p>
                  <p className="text-sm">P&L: {fmtUsd(row.totalPnl, 2, true)} · Avg {row.avgDaysHeld}d</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {recentTrades.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold">Recent swing trades</h3>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[hsl(var(--secondary))]">
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="px-4 py-2 text-left font-medium">Ticker</th>
                  <th className="px-4 py-2 text-left font-medium">Signal</th>
                  <th className="px-4 py-2 text-left font-medium">Filled</th>
                  <th className="px-4 py-2 text-left font-medium">Closed</th>
                  <th className="px-4 py-2 text-right font-medium">P&L</th>
                  <th className="px-4 py-2 text-left font-medium">Close</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((t, i) => (
                  <tr key={i} className="border-b border-[hsl(var(--border))]/50 hover:bg-[hsl(var(--secondary))]/30">
                    <td className="px-4 py-2 font-medium">{t.ticker}</td>
                    <td className="px-4 py-2">{t.signal}</td>
                    <td className="px-4 py-2 text-[hsl(var(--muted-foreground))]">
                      {t.filledAt ? new Date(t.filledAt).toLocaleDateString(undefined, { dateStyle: 'short' }) : '—'}
                    </td>
                    <td className="px-4 py-2 text-[hsl(var(--muted-foreground))]">
                      {t.closedAt ? new Date(t.closedAt).toLocaleDateString(undefined, { dateStyle: 'short' }) : '—'}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-medium ${(t.pnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {t.pnl != null ? fmtUsd(t.pnl, 2, true) : '—'}
                    </td>
                    <td className="px-4 py-2 text-[hsl(var(--muted-foreground))]">{t.closeReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {funnel.signals === 0 && recentTrades.length === 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center text-[hsl(var(--muted-foreground))]">
          No swing data yet. Run for 2–3 weeks to see funnel + diagnostics.
        </div>
      )}
    </div>
  );
}

export function ValidationTab({ dayReport, swingReport, onRefresh }: ValidationTabProps) {
  const [subTab, setSubTab] = useState<'day' | 'swing'>('day');
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setSubTab('day')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${subTab === 'day' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'}`}
          >
            Day Trade
          </button>
          <button
            onClick={() => setSubTab('swing')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${subTab === 'swing' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'}`}
          >
            Swing Trade
          </button>
        </div>
        <button
          onClick={onRefresh}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))] text-sm"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>
      {subTab === 'day' && <DayTradeValidationTab report={dayReport} />}
      {subTab === 'swing' && <SwingTradeValidationTab report={swingReport} onRefresh={onRefresh} />}
    </div>
  );
}
