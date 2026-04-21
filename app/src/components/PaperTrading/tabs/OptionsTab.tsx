import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, AlertTriangle, CheckCircle, BarChart2, Activity } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { fmtUsd } from '../utils';
import {
  getOptionsWatchlist,
  getLatestOptionsScan,
  getSkippedOptionsScan,
  getOpenOptionsPositions,
  getClosedOptionsPositions,
  getOptionsMonthlyStats,
  getOptionsActivityLog,
  addToOptionsWatchlist,
  removeFromOptionsWatchlist,
  paperTradeOptionManually,
  type WatchlistTicker,
  type OptionsScanOpportunity,
  type OpenOptionsPosition,
  type OptionsMonthlyStats,
  type OptionsActivityEvent,
} from '../../../lib/optionsApi';

// ── Helpers ──────────────────────────────────────────────

function daysUntil(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function formatExpiry(dateStr: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dteBadgeColor(dte: number): string {
  if (dte <= 7) return 'bg-red-100 text-red-700';
  if (dte <= 21) return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
}

/**
 * Annualized return on capital reserved.
 * Formula: (pnl / capitalReq) × (365 / daysHeld) × 100
 * For open positions, daysHeld = elapsed since opened_at (minimum 1 day).
 * For closed positions, daysHeld = closed_at - opened_at.
 */
function calcAnnualizedROC(
  pnl: number | null,
  capitalReq: number | null,
  openedAt: string,
  closedAt?: string | null,
): number | null {
  if (pnl == null || !capitalReq || capitalReq <= 0) return null;
  const start = new Date(openedAt).getTime();
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  const daysHeld = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
  return (pnl / capitalReq) * (365 / daysHeld) * 100;
}

// ── Trade Opportunity Card ────────────────────────────────

function OpportunityCard({ opp, onPaperTrade }: { opp: OptionsScanOpportunity; onPaperTrade: (opp: OptionsScanOpportunity) => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const dte = daysUntil(opp.expiry);

  async function handlePaperTrade() {
    setLoading(true);
    try {
      await onPaperTrade(opp);
      setDone(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-[hsl(var(--foreground))]">{opp.ticker}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-semibold">SELL PUT</span>
            {opp.leverage_factor && opp.leverage_factor > 1 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-bold">{opp.leverage_factor}x ETF</span>
            )}
            {opp.dip_entry && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">📉 DIP ENTRY</span>
            )}
            {opp.bear_mode && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">🐻 BEAR MODE</span>
            )}
            {opp.iv_rank && opp.iv_rank >= 60 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-semibold">IV {opp.iv_rank}%</span>
            )}
          </div>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
            ${opp.strike} strike · {formatExpiry(opp.expiry)} · {dte}d
          </p>
        </div>
        <div className="text-right">
          <p className="text-base font-bold text-emerald-600">+${Math.round(opp.premium * 100)}</p>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            {opp.contracts && opp.contracts > 1
              ? <span className="text-violet-600 font-semibold">{opp.contracts}x contracts</span>
              : '1 contract'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="bg-[hsl(var(--muted))]/40 rounded-lg p-2">
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Net Price</p>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">${opp.net_price?.toFixed(2)}</p>
          <p className="text-[9px] text-emerald-600">entry price if assigned</p>
        </div>
        <div className="bg-[hsl(var(--muted))]/40 rounded-lg p-2">
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Prob Profit</p>
          <p className={cn('text-xs font-bold', opp.prob_profit >= 70 ? 'text-emerald-600' : 'text-amber-600')}>
            {opp.prob_profit?.toFixed(0)}%
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">win probability</p>
        </div>
        <div className="bg-[hsl(var(--muted))]/40 rounded-lg p-2">
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Annual Yield</p>
          <p className={cn('text-xs font-bold', opp.annual_yield >= 40 ? 'text-emerald-600' : 'text-blue-600')}>
            {opp.annual_yield?.toFixed(1)}%
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">on capital</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          Reserve <span className="font-semibold">${(opp.capital_req / 1000).toFixed(0)}K</span> · worst case you own the stock at net cost
        </p>
        {done ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-600 font-semibold">
            <CheckCircle className="w-3 h-3" /> Paper traded
          </span>
        ) : (
          <button
            onClick={handlePaperTrade}
            disabled={loading}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-violet-600 text-white font-semibold hover:bg-violet-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Adding...' : 'Paper Trade'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Open Position Card ────────────────────────────────────

function PositionCard({ pos }: { pos: OpenOptionsPosition }) {
  const dte = daysUntil(pos.option_expiry);
  const profitCapturePct = pos.option_premium && pos.pnl != null
    ? Math.max(0, (pos.pnl / (pos.option_premium * 100)) * 100)
    : null;
  const annualROC = calcAnnualizedROC(pos.pnl, pos.option_capital_req, pos.opened_at, pos.closed_at);

  return (
    <div className={cn(
      'rounded-xl border p-3',
      dte <= 7 ? 'border-red-200 bg-red-50' :
      dte <= 21 ? 'border-amber-200 bg-amber-50' :
      'border-[hsl(var(--border))] bg-[hsl(var(--card))]'
    )}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[hsl(var(--foreground))]">{pos.ticker}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">PUT</span>
          {pos.option_assigned && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">ASSIGNED</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {annualROC != null && (
            <span className={cn(
              'text-[10px] px-2 py-0.5 rounded-full font-semibold',
              annualROC >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
            )}>
              {annualROC >= 0 ? '+' : ''}{annualROC.toFixed(0)}% ann.
            </span>
          )}
          <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-semibold', dteBadgeColor(dte))}>
            {dte}d left
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 text-center mb-1">
        <div>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">Strike</p>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">${pos.option_strike}</p>
        </div>
        <div>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">Break-Even</p>
          <p className="text-xs font-bold text-violet-700">${(pos.option_net_price ?? (pos.option_strike - pos.option_premium)).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">Expiry</p>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">{formatExpiry(pos.option_expiry)}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 text-center">
        <div>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">Collected</p>
          <p className="text-xs font-bold text-emerald-600">+${Math.round((pos.option_premium ?? 0) * 100)}</p>
        </div>
        <div>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">P&L</p>
          <p className={cn('text-xs font-bold', (pos.pnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {fmtUsd(pos.pnl ?? 0, 0, true)}
          </p>
        </div>
        <div>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))]">Captured</p>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">
            {profitCapturePct != null ? `${profitCapturePct.toFixed(0)}%` : '—'}
          </p>
        </div>
      </div>

      {dte <= 21 && !pos.option_assigned && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-700">
          <AlertTriangle className="w-3 h-3" />
          <span>{dte <= 7 ? 'Expiring soon — let it expire or roll to next month' : 'Within 21 days — consider rolling to collect more premium'}</span>
        </div>
      )}
      {pos.option_assigned && (
        <div className="mt-2 rounded-lg bg-blue-50 border border-blue-200 px-2 py-1.5">
          <p className="text-[10px] font-semibold text-blue-700">📌 Wheel step 2 — you now own 100 shares</p>
          <p className="text-[10px] text-blue-600 mt-0.5">Sell a covered call above your net cost to keep collecting premium.</p>
        </div>
      )}
    </div>
  );
}

// ── How It Works Strip ───────────────────────────────────

const STEPS = [
  {
    icon: '🔍',
    title: 'Morning Scan',
    desc: 'Every day at 10 AM ET the engine screens your watchlist — checking IV rank, earnings proximity, trend, beta, and news.',
  },
  {
    icon: '💰',
    title: 'Sell a Put',
    desc: 'On qualifying stocks, it sells a cash-secured put at the 20-delta strike. You collect premium upfront — that\'s yours regardless.',
  },
  {
    icon: '⏳',
    title: 'Let Time Decay Work',
    desc: 'Theta (time decay) erodes the option\'s value daily. At 50% profit the position auto-closes to lock in gains and free up capital.',
  },
  {
    icon: '🔄',
    title: 'Roll or Repeat',
    desc: 'Near expiry, decide to roll to the next month or let it expire worthless. If assigned, sell covered calls on the shares.',
  },
];

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-violet-100 bg-violet-50/50 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-violet-50 transition-colors"
      >
        <span className="text-xs font-semibold text-violet-700">How the wheel works</span>
        <span className="text-[10px] text-violet-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-px bg-violet-100 border-t border-violet-100 sm:grid-cols-4">
          {STEPS.map((step, i) => (
            <div key={i} className="bg-white/80 px-3 py-3 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-base">{step.icon}</span>
                <span className="text-[11px] font-bold text-violet-800">{step.title}</span>
              </div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Tab ─────────────────────────────────────────────

function formatSkipReason(reason: string): string {
  if (reason.startsWith('earnings_in_')) return `Earnings in ${reason.split('_')[2]}d`;
  if (reason.startsWith('high_beta:')) return `Beta too high (${reason.split(':')[1]})`;
  if (reason.startsWith('below_sma50:')) return `Below 50d SMA ($${reason.split(':')[1]})`;
  if (reason.startsWith('down_')) return `Down ${reason.split('_')[1]} in 3mo`;
  if (reason.startsWith('low_premium_')) return `Premium too low`;
  if (reason.startsWith('wide_spread:')) return `Wide bid/ask spread`;
  if (reason.startsWith('sector_limit:')) return `Sector cap (${reason.split(':')[1]})`;
  if (reason.startsWith('bear_mode_non_defensive:')) return `Bear mode — non-defensive sector`;
  if (reason.startsWith('negative_sentiment:')) return `Negative news sentiment`;
  if (reason.startsWith('news_red_flag:')) return `Red flag in news (${reason.split(':')[1]})`;
  if (reason.startsWith('iv_spike:')) return `IV spike detected`;
  if (reason === 'duplicate_open_position') return 'Already have an open position';
  if (reason === 'max_positions') return 'Max positions reached';
  if (reason === 'insufficient_capital') return 'Insufficient capital';
  if (reason === 'no_options_chain') return 'No options chain data';
  if (reason === 'no_bid_no_market') return 'No bid — illiquid';
  if (reason === 'too_early_opening_30min') return 'Too early (opening volatility)';
  return reason.replace(/_/g, ' ');
}

export function OptionsTab() {
  const [opportunities, setOpportunities] = useState<OptionsScanOpportunity[]>([]);
  const [skipped, setSkipped] = useState<OptionsScanOpportunity[]>([]);
  const [openPositions, setOpenPositions] = useState<OpenOptionsPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<OpenOptionsPosition[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistTicker[]>([]);
  const [stats, setStats] = useState<OptionsMonthlyStats | null>(null);
  const [activityLog, setActivityLog] = useState<OptionsActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);
  const [addTicker, setAddTicker] = useState('');
  const [addingTicker, setAddingTicker] = useState(false);
  const [activeSection, setActiveSection] = useState<'opportunities' | 'positions' | 'history' | 'watchlist' | 'log'>('opportunities');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [opps, skippedOpps, openPos, closedPos, wl, monthStats, log] = await Promise.all([
        getLatestOptionsScan(),
        getSkippedOptionsScan(),
        getOpenOptionsPositions(),
        getClosedOptionsPositions(20),
        getOptionsWatchlist(),
        getOptionsMonthlyStats(),
        getOptionsActivityLog(50),
      ]);
      setOpportunities(opps);
      setSkipped(skippedOpps);
      setOpenPositions(openPos);
      setClosedPositions(closedPos);
      setWatchlist(wl);
      setStats(monthStats);
      setActivityLog(log);
    } catch (err) {
      console.error('Options tab load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAddTicker() {
    if (!addTicker.trim()) return;
    setAddingTicker(true);
    try {
      await addToOptionsWatchlist(addTicker.trim().toUpperCase());
      setAddTicker('');
      await load();
    } finally {
      setAddingTicker(false);
    }
  }

  async function handleRemoveTicker(ticker: string) {
    await removeFromOptionsWatchlist(ticker);
    await load();
  }

  async function handlePaperTrade(opp: OptionsScanOpportunity) {
    await paperTradeOptionManually(opp);
    await load();
  }

  const sections = [
    { id: 'opportunities' as const, label: 'Today', count: opportunities.length },
    { id: 'positions' as const, label: 'Open', count: openPositions.length },
    { id: 'history' as const, label: 'History', count: closedPositions.length },
    { id: 'watchlist' as const, label: 'Watchlist', count: watchlist.filter(w => w.active).length },
    { id: 'log' as const, label: 'Log', count: activityLog.length },
  ];

  return (
    <div className="space-y-4">
      {/* Refresh + PAPER badge */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 font-semibold">PAPER</span>
        <button onClick={load} disabled={loading} className="p-1.5 rounded-lg hover:bg-[hsl(var(--muted))] transition-colors">
          <RefreshCw className={cn('w-4 h-4 text-[hsl(var(--muted-foreground))]', loading && 'animate-spin')} />
        </button>
      </div>

      {/* How it works */}
      <HowItWorks />

      {/* Monthly Scorecard */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
            <p className="text-[9px] text-emerald-700 uppercase tracking-wide font-semibold">Premium This Month</p>
            <p className="text-lg font-bold text-emerald-700">{fmtUsd(stats.premiumCollected, 0, true)}</p>
          </div>
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-center">
            <p className="text-[9px] text-violet-700 uppercase tracking-wide font-semibold">Win Rate</p>
            <p className={cn('text-lg font-bold', stats.winRate >= 70 ? 'text-emerald-600' : 'text-amber-600')}>
              {stats.winRate.toFixed(0)}%
            </p>
            <p className="text-[9px] text-violet-600">{stats.wins}W / {stats.losses}L</p>
          </div>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-center">
            <p className="text-[9px] text-blue-700 uppercase tracking-wide font-semibold">Annual Rate</p>
            <p className={cn('text-lg font-bold', stats.annualizedReturn >= 60 ? 'text-emerald-600' : 'text-blue-600')}>
              {stats.annualizedReturn.toFixed(0)}%
            </p>
            <p className="text-[9px] text-blue-600">annualized</p>
          </div>
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 text-center">
            <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide font-semibold">Open Positions</p>
            <p className="text-lg font-bold text-[hsl(var(--foreground))]">{stats.openPositions}</p>
            <p className="text-[9px] text-[hsl(var(--muted-foreground))]">active puts</p>
          </div>
        </div>
      )}

      {/* Section Tabs */}
      <div className="flex gap-1 bg-[hsl(var(--muted))]/50 p-1 rounded-xl overflow-x-auto">
        {sections.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={cn(
              'flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              activeSection === s.id
                ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            )}
          >
            {s.label}
            {s.count > 0 && (
              <span className={cn(
                'text-[9px] px-1.5 py-0.5 rounded-full font-bold',
                activeSection === s.id ? 'bg-violet-100 text-violet-700' : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
              )}>
                {s.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Today's Opportunities */}
      {activeSection === 'opportunities' && (
        <div className="space-y-3">
          {loading ? (
            <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">Scanning watchlist...</div>
          ) : opportunities.length === 0 ? (
            <div className="space-y-3">
              <div className="text-center py-6 space-y-2">
                <BarChart2 className="w-8 h-8 mx-auto text-[hsl(var(--muted-foreground))] opacity-40" />
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {openPositions.length > 0 ? 'Today\'s trades are open' : 'No opportunities found today'}
                </p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-60">
                  {openPositions.length > 0
                    ? `The auto-trader placed ${openPositions.length} put${openPositions.length > 1 ? 's' : ''} this morning — check the Open tab to manage them.`
                    : 'Scan runs 10–11:30 AM ET on weekdays. Add quality stocks to your watchlist to get picks.'
                  }
                </p>
              </div>
              {skipped.length > 0 && (
                <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
                  <button
                    onClick={() => setShowSkipped(v => !v)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-[hsl(var(--muted))]/40 hover:bg-[hsl(var(--muted))]/60 transition-colors text-left"
                  >
                    <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">
                      Why were {skipped.length} tickers filtered out?
                    </span>
                    <span className="text-xs text-[hsl(var(--muted-foreground))]">{showSkipped ? '▲' : '▼'}</span>
                  </button>
                  {showSkipped && (
                    <div className="divide-y divide-[hsl(var(--border))]">
                      {skipped.map(s => (
                        <div key={s.id} className="flex items-center justify-between px-4 py-2">
                          <span className="text-xs font-semibold text-[hsl(var(--foreground))]">{s.ticker}</span>
                          <span className="text-xs text-[hsl(var(--muted-foreground))]">
                            {formatSkipReason(s.skip_reason ?? '')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            opportunities.map(opp => (
              <OpportunityCard key={opp.id} opp={opp} onPaperTrade={handlePaperTrade} />
            ))
          )}
        </div>
      )}

      {/* Open Positions */}
      {activeSection === 'positions' && (
        <div className="space-y-3">
          {openPositions.length === 0 ? (
            <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">No open options positions</div>
          ) : (
            openPositions.map(pos => <PositionCard key={pos.id} pos={pos} />)
          )}
        </div>
      )}

      {/* History */}
      {activeSection === 'history' && (
        <div className="space-y-2">
          {closedPositions.length === 0 ? (
            <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">No closed options trades yet</div>
          ) : (
            closedPositions.map(pos => {
              const isRolled = pos.close_reason === 'rolled';
              const isStopped = pos.close_reason === 'stop_loss';
              const isExpired = pos.close_reason === 'expired_worthless';
              const isProfit = pos.close_reason === '50pct_profit';
              const is21DteWin = pos.close_reason === '21dte_profit';
              const is21DteCut = pos.close_reason === '21dte_close';
              const histROC = calcAnnualizedROC(pos.pnl, pos.option_capital_req, pos.opened_at, pos.closed_at);
              return (
                <div key={pos.id} className={cn(
                  'flex items-center justify-between rounded-xl border p-3',
                  isRolled ? 'border-blue-200 bg-blue-50' :
                  isStopped ? 'border-red-200 bg-red-50' :
                  'border-[hsl(var(--border))] bg-[hsl(var(--card))]'
                )}>
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold">{pos.ticker}</span>
                      <span className="text-[10px] px-1 py-0.5 rounded bg-violet-100 text-violet-700">PUT</span>
                      {isRolled   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">↩️ Rolled</span>}
                      {isStopped  && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">🛑 Stopped</span>}
                      {isExpired  && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">✅ Expired</span>}
                      {isProfit   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">💰 50% Close</span>}
                      {is21DteWin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">⏱️ 21 DTE Close</span>}
                      {is21DteCut && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">⚠️ 21 DTE Cut</span>}
                      {pos.option_assigned && <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">Assigned</span>}
                    </div>
                    <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                      Strike ${pos.option_strike} · Collected ${Math.round((pos.option_premium ?? 0) * 100)} · Exp {formatExpiry(pos.option_expiry)}
                    </p>
                    {isRolled && pos.notes && (
                      <p className="text-[10px] text-blue-600 mt-0.5">{pos.notes}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className={cn('text-sm font-bold', (pos.pnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                      {fmtUsd(pos.pnl ?? 0, 0, true)}
                    </p>
                    {histROC != null && (
                      <p className={cn('text-[10px] font-semibold', histROC >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                        {histROC >= 0 ? '+' : ''}{histROC.toFixed(0)}% ann. ROC
                      </p>
                    )}
                    <p className="text-[9px] text-[hsl(var(--muted-foreground))]">{pos.close_reason?.replace(/_/g, ' ') ?? pos.status.toLowerCase()}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Activity Log */}
      {activeSection === 'log' && (
        <div className="space-y-2">
          {activityLog.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[hsl(var(--border))] p-6 text-center">
              <Activity className="w-8 h-8 text-[hsl(var(--muted-foreground))] mx-auto mb-2 opacity-40" />
              <p className="text-sm text-[hsl(var(--muted-foreground))]">No activity yet.</p>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1 opacity-70">Events appear here when scans run, orders are placed, and positions close.</p>
            </div>
          ) : (
            activityLog.map(evt => (
              <div
                key={evt.id}
                className={cn(
                  'flex gap-3 rounded-xl border px-3 py-2.5 text-sm',
                  evt.event_type === 'success' && 'border-emerald-200 bg-emerald-50',
                  evt.event_type === 'warning' && 'border-amber-200 bg-amber-50',
                  evt.event_type === 'error'   && 'border-red-200 bg-red-50',
                  evt.event_type === 'info'    && 'border-[hsl(var(--border))] bg-[hsl(var(--card))]',
                )}
              >
                {/* icon */}
                <div className="mt-0.5 shrink-0">
                  {evt.event_type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-600" />}
                  {evt.event_type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-600" />}
                  {evt.event_type === 'error'   && <AlertTriangle className="w-4 h-4 text-red-600" />}
                  {evt.event_type === 'info'    && <Activity className="w-4 h-4 text-violet-500" />}
                </div>
                {/* body */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span className={cn(
                      'text-[11px] font-bold uppercase tracking-wide',
                      evt.event_type === 'success' && 'text-emerald-700',
                      evt.event_type === 'warning' && 'text-amber-700',
                      evt.event_type === 'error'   && 'text-red-700',
                      evt.event_type === 'info'    && 'text-violet-700',
                    )}>{evt.ticker}</span>
                    <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                      {new Date(evt.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className={cn(
                    'text-[12px] leading-snug mt-0.5',
                    evt.event_type === 'success' && 'text-emerald-800',
                    evt.event_type === 'warning' && 'text-amber-800',
                    evt.event_type === 'error'   && 'text-red-800',
                    evt.event_type === 'info'    && 'text-[hsl(var(--foreground))]',
                  )}>{evt.message}</p>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Watchlist */}
      {activeSection === 'watchlist' && (
        <div className="space-y-3">
          {/* Add ticker */}
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Add ticker (e.g. AAPL)"
              value={addTicker}
              onChange={e => setAddTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleAddTicker()}
              className="flex-1 text-sm px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <button
              onClick={handleAddTicker}
              disabled={addingTicker || !addTicker.trim()}
              className="px-3 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Watchlist items */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {watchlist.filter(w => w.active).map(w => (
              <div key={w.id} className="flex items-start justify-between rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[hsl(var(--foreground))]">{w.ticker}</p>
                  {w.notes && <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-snug">{w.notes}</p>}
                </div>
                <button
                  onClick={() => handleRemoveTicker(w.ticker)}
                  className="p-1 mt-0.5 shrink-0 rounded hover:bg-[hsl(var(--muted))] transition-colors"
                >
                  <X className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
