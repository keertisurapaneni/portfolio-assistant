import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, AlertTriangle, CheckCircle, Activity, Pencil, Check, TrendingUp, DollarSign } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { fmtUsd } from '../utils';
import {
  getOptionsWatchlist,
  getOpenOptionsPositions,
  getClosedOptionsPositions,
  getOptionsMonthlyStats,
  getOptionsActivityLog,
  getOptionsMaxAllocation,
  addToOptionsWatchlist,
  removeFromOptionsWatchlist,
  updateOptionsWatchlistNotes,
  lookupTickerDescription,
  fetchWatchlistQuotes,
  type TickerQuote,
  type WatchlistTicker,
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

function fmtK(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

// ── Open Position Card ────────────────────────────────────

function PositionCard({
  pos,
  currentPrice,
  atRisk,
  atRiskReason,
}: {
  pos: OpenOptionsPosition;
  currentPrice?: TickerQuote;
  atRisk?: boolean;
  atRiskReason?: string;
}) {
  const dte = daysUntil(pos.option_expiry);
  const annualROC = calcAnnualizedROC(pos.pnl, pos.option_capital_req, pos.opened_at, pos.closed_at);

  const priceDist = currentPrice != null
    ? ((currentPrice.price - pos.option_strike) / pos.option_strike) * 100
    : null;

  const borderClass = atRisk
    ? 'border-amber-300 bg-amber-50/60'
    : dte <= 7 ? 'border-red-200 bg-red-50'
    : dte <= 21 ? 'border-amber-200 bg-amber-50'
    : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]';

  return (
    <div className={cn('rounded-xl border p-3', borderClass)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[hsl(var(--foreground))]">{pos.ticker}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">
            {pos.mode === 'OPTIONS_CALL' ? 'CALL' : 'PUT'}
          </span>
          {pos.option_assigned && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">ASSIGNED</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {currentPrice != null && (
            <span className={cn(
              'text-[10px] px-2 py-0.5 rounded-full font-semibold tabular-nums',
              priceDist != null && priceDist < 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
            )}>
              ${currentPrice.price.toFixed(2)}
              {priceDist != null && (
                <span className="ml-1 opacity-70">{priceDist >= 0 ? '+' : ''}{priceDist.toFixed(1)}%</span>
              )}
            </span>
          )}
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

      {/* Single data row: 5 columns, labels below values */}
      <div className="grid grid-cols-5 gap-1 text-center">
        <div>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">${pos.option_strike}</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Strike</p>
        </div>
        <div>
          <p className="text-xs font-bold text-violet-700">
            ${(pos.option_net_price ?? (pos.option_strike - pos.option_premium)).toFixed(2)}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">B/E</p>
        </div>
        <div>
          <p className="text-xs font-bold text-emerald-600">+${Math.round((pos.option_premium ?? 0) * (pos.option_contracts ?? 1) * 100)}</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Collected</p>
        </div>
        <div>
          <p className={cn('text-xs font-bold', (pos.pnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {fmtUsd(pos.pnl ?? 0, 0, true)}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">P&L</p>
        </div>
        <div>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">{formatExpiry(pos.option_expiry)}</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Expiry</p>
        </div>
      </div>

      {/* Needs Attention — reason banner */}
      {atRisk && atRiskReason && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2">
          <AlertTriangle className="w-3 h-3 text-amber-600 mt-0.5 flex-shrink-0" />
          <p className="text-[10px] text-amber-800 leading-snug">{atRiskReason}</p>
        </div>
      )}

      {/* Strike explanation panel */}
      <div className="mt-2 rounded-lg bg-[hsl(var(--muted))]/30 border border-[hsl(var(--border))] px-2.5 py-2 space-y-1.5">
        {/* Header row: placed date + delta badge */}
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Placed{' '}
            <span className="font-semibold text-[hsl(var(--foreground))]">
              {new Date(pos.opened_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </p>
          {pos.option_delta != null && (
            <span className="text-[10px] font-semibold bg-violet-50 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded-full">
              Δ {Math.abs(pos.option_delta).toFixed(2)} · {Math.round((1 - Math.abs(pos.option_delta)) * 100)}% prob OTM
            </span>
          )}
        </div>

        {/* Why this strike */}
        <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-snug">
          <span className="font-medium text-[hsl(var(--foreground))]">Strike basis:</span>{' '}
          ~30-delta targeting with a 20-day SMA floor — stock must break below its own 20-day average before assignment risk kicks in.
        </p>

        {/* Scanner metrics */}
        {pos.scanner_reason && (
          <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-snug">
            <span className="font-medium text-[hsl(var(--foreground))]">At entry:</span>{' '}
            {pos.scanner_reason}
          </p>
        )}

        {/* Notes (entry summary from scanner) */}
        {pos.notes && (
          <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-snug italic">
            {pos.notes.replace(/^\[(AUTO|PAPER)\]\s*/i, '')}
          </p>
        )}
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
    desc: 'Every day at 10 AM ET the engine screens the watchlist — 14 checks including IV rank, Bollinger Bands, earnings proximity, trend, beta, sector concentration, and news sentiment. A 1:30 PM re-scan redeploys capital freed by early closes.',
  },
  {
    icon: '💰',
    title: 'Sell a Put',
    desc: 'On qualifying stocks, it sells a cash-secured put at the 30-delta strike (below the 20-day SMA floor). Premium is collected upfront — yours to keep regardless of outcome.',
  },
  {
    icon: '⏳',
    title: 'Let Time Decay Work',
    desc: 'Theta erodes the option\'s value daily. At 50% profit the position auto-closes to lock in gains and free up capital. Hard close at 21 DTE. Stop-loss if premium exceeds 3× collected.',
  },
  {
    icon: '🔄',
    title: 'Roll or Repeat',
    desc: 'If stock drops 3%+ below strike, a roll alert fires. If assigned, a covered call is automatically opened to collect more premium. The wheel is self-sustaining.',
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

// ── Stats Header ─────────────────────────────────────────

const MONTHLY_INCOME_TARGET = 5_000;

function StatsHeader({
  stats,
  deployed,
  maxAllocation,
  openPositions,
  openPrices,
}: {
  stats: OptionsMonthlyStats;
  deployed: number;
  maxAllocation: number;
  openPositions: OpenOptionsPosition[];
  openPrices: Map<string, TickerQuote>;
}) {
  // Unrealized P&L across all open positions (negative = losing on premium value)
  const totalUnrealizedPnl = openPositions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  // Net income = premiums locked in from closed trades minus open position losses
  // This is the honest number: if you had to close everything today, this is what you keep.
  const netIncome = stats.premiumCollected + totalUnrealizedPnl;
  const netProgress = Math.min(Math.max(netIncome, 0) / MONTHLY_INCOME_TARGET, 1);
  const netProgressPct = Math.round(netProgress * 100);
  const barColor = netProgress > 0.5 ? 'bg-emerald-500' : netProgress > 0.25 ? 'bg-amber-400' : 'bg-red-400';

  // Crash scenario — estimated loss if all put positions were assigned at depressed prices.
  // This is the honest tail risk: the "steamroller" figure, not the win-rate figure.
  const crashLoss30 = openPositions.reduce((s, p) => {
    const currentPrice = openPrices.get(p.ticker)?.price ?? (p.option_strike * 0.95);
    const crashPrice = currentPrice * 0.70;
    if (p.option_strike <= crashPrice) return s; // still OTM — no loss at this crash level
    const lossPerShare = p.option_strike - crashPrice;
    const premiumCollectedPerShare = p.option_premium ?? 0;
    return s + Math.max(0, (lossPerShare - premiumCollectedPerShare) * 100 * (p.option_contracts ?? 1));
  }, 0);
  const crashLoss50 = openPositions.reduce((s, p) => {
    const currentPrice = openPrices.get(p.ticker)?.price ?? (p.option_strike * 0.95);
    const crashPrice = currentPrice * 0.50;
    const lossPerShare = Math.max(0, p.option_strike - crashPrice);
    const premiumCollectedPerShare = p.option_premium ?? 0;
    return s + Math.max(0, (lossPerShare - premiumCollectedPerShare) * 100 * (p.option_contracts ?? 1));
  }, 0);

  const deployedPct = maxAllocation > 0 ? Math.min(deployed / maxAllocation, 1) : 0;
  const available = Math.max(maxAllocation - deployed, 0);

  return (
    <div className="space-y-2">
      {/* Income progress row */}
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-700" />
            <span className="text-xs font-semibold text-emerald-800">Monthly Income Target</span>
          </div>
          <span className="text-[10px] text-emerald-700">
            Projected: <span className="font-semibold">{fmtUsd(stats.projectedMonthlyIncome, 0)}</span> if all held
          </span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-emerald-800">
              Net this month: {fmtUsd(netIncome, 0)} / {fmtUsd(MONTHLY_INCOME_TARGET, 0)}
            </span>
            <span className={cn(
              'font-bold text-[10px]',
              netProgress > 0.5 ? 'text-emerald-700' : netProgress > 0.25 ? 'text-amber-600' : 'text-red-600'
            )}>
              {netProgressPct}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-emerald-100 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${netProgressPct}%` }}
            />
          </div>
          {/* Honest breakdown: closed premiums vs open unrealized */}
          <div className="flex items-center gap-2 text-[10px] pt-0.5">
            <span className="text-emerald-700">
              Closed: <span className="font-semibold">{fmtUsd(stats.premiumCollected, 0)}</span>
            </span>
            <span className="text-[hsl(var(--muted-foreground))]">·</span>
            <span className={cn(totalUnrealizedPnl >= 0 ? 'text-emerald-700' : 'text-red-600')}>
              Open P&L: <span className="font-semibold">{fmtUsd(totalUnrealizedPnl, 0, true)}</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-emerald-700">
          <span>{stats.wins}W / {stats.losses}L · {stats.winRate.toFixed(0)}% win rate</span>
          <span>·</span>
          <span>{stats.annualizedReturn.toFixed(0)}% annualized</span>
        </div>
      </div>

      {/* Crash scenario card — honest tail risk visibility */}
      {openPositions.length > 0 && (crashLoss30 > 0 || crashLoss50 > 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-700" />
            <span className="text-xs font-semibold text-amber-800">Tail Risk — Crash Scenarios</span>
          </div>
          <p className="text-[10px] text-amber-700 leading-relaxed">
            Estimated loss if all open puts were assigned at depressed prices (premium offsets included).
          </p>
          <div className="grid grid-cols-2 gap-2 pt-0.5">
            <div className="rounded-lg bg-amber-100/80 px-3 py-2 text-center">
              <p className="text-[10px] text-amber-600 font-medium">Market −30%</p>
              <p className="text-sm font-bold text-amber-800">
                {crashLoss30 > 0 ? `−${fmtUsd(crashLoss30, 0)}` : '✓ All OTM'}
              </p>
            </div>
            <div className="rounded-lg bg-red-100/80 px-3 py-2 text-center">
              <p className="text-[10px] text-red-600 font-medium">Market −50%</p>
              <p className="text-sm font-bold text-red-800">
                {crashLoss50 > 0 ? `−${fmtUsd(crashLoss50, 0)}` : '✓ All OTM'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Budget meter */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <DollarSign className="w-3.5 h-3.5 text-blue-600" />
            <span className="text-xs font-semibold text-[hsl(var(--foreground))]">Options Capital</span>
          </div>
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Available: <span className="font-semibold text-emerald-600">{fmtK(available)}</span>
          </span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-[hsl(var(--foreground))]">
              {fmtK(deployed)} / {fmtK(maxAllocation)} deployed
            </span>
            <span className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
              {Math.round(deployedPct * 100)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                deployedPct > 0.8 ? 'bg-amber-400' : 'bg-blue-500'
              )}
              style={{ width: `${Math.round(deployedPct * 100)}%` }}
            />
          </div>
        </div>
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          {stats.openPositions} open position{stats.openPositions !== 1 ? 's' : ''} · cash-secured puts reserved
        </p>
      </div>
    </div>
  );
}

// ── Main Tab ─────────────────────────────────────────────

export function OptionsTab() {
  const [openPositions, setOpenPositions] = useState<OpenOptionsPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<OpenOptionsPosition[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistTicker[]>([]);
  const [stats, setStats] = useState<OptionsMonthlyStats | null>(null);
  const [activityLog, setActivityLog] = useState<OptionsActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [addTicker, setAddTicker] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addingTicker, setAddingTicker] = useState(false);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [editNotesValue, setEditNotesValue] = useState('');
  const [prices, setPrices] = useState<Map<string, TickerQuote>>(new Map());
  const [openPrices, setOpenPrices] = useState<Map<string, TickerQuote>>(new Map());
  const [maxAllocation, setMaxAllocation] = useState<number>(500_000);
  const [activeSection, setActiveSection] = useState<'positions' | 'history' | 'watchlist' | 'log'>('positions');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [openPos, closedPos, wl, monthStats, log] = await Promise.all([
        getOpenOptionsPositions(),
        getClosedOptionsPositions(20),
        getOptionsWatchlist(),
        getOptionsMonthlyStats(),
        getOptionsActivityLog(50),
      ]);
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

  // Fetch max allocation from config once
  useEffect(() => {
    getOptionsMaxAllocation().then(v => { if (v != null) setMaxAllocation(v); });
  }, []);

  // Fetch live prices for open positions whenever positions load
  useEffect(() => {
    if (openPositions.length === 0) return;
    const tickers = [...new Set(openPositions.map(p => p.ticker))];
    fetchWatchlistQuotes(tickers).then(setOpenPrices);
  }, [openPositions]);

  // Fetch live prices for watchlist tab
  useEffect(() => {
    if (activeSection !== 'watchlist') return;
    const tickers = watchlist.filter(w => w.active).map(w => w.ticker);
    if (tickers.length === 0) return;
    fetchWatchlistQuotes(tickers).then(setPrices);
  }, [activeSection, watchlist]);

  async function handleAddTicker() {
    if (!addTicker.trim()) return;
    setAddingTicker(true);
    try {
      const ticker = addTicker.trim().toUpperCase();
      const notes = addNotes.trim() || (await lookupTickerDescription(ticker)) || undefined;
      await addToOptionsWatchlist(ticker, notes);
      setAddTicker('');
      setAddNotes('');
      await load();
    } finally {
      setAddingTicker(false);
    }
  }

  async function handleRemoveTicker(ticker: string) {
    await removeFromOptionsWatchlist(ticker);
    await load();
  }

  async function handleSaveNotes(ticker: string) {
    await updateOptionsWatchlistNotes(ticker, editNotesValue);
    setEditingNotes(null);
    await load();
  }

  // Split open positions into needs-attention and healthy, computing the reason for each flagged position.
  const deployed = openPositions.reduce((s, p) => {
    return s + (p.option_strike * 100 * (p.option_contracts ?? 1));
  }, 0);

  const atRiskReasons = new Map<string, string>();

  const [needsAttention, healthy] = openPositions.reduce<[OpenOptionsPosition[], OpenOptionsPosition[]]>(
    ([atRiskList, ok], pos) => {
      const price = openPrices.get(pos.ticker);
      const pnlNegative = (pos.pnl ?? 0) < 0;
      // Flag only when stock is actually below the strike — genuine assignment risk.
      // P&L negative already catches above-strike positions that are losing money.
      const belowStrike = price != null && price.price < pos.option_strike;

      if (belowStrike && pnlNegative) {
        const gap = pos.option_strike - (price?.price ?? 0);
        atRiskReasons.set(pos.id,
          `Stock at $${price!.price.toFixed(2)} is $${gap.toFixed(2)} below your $${pos.option_strike} strike — assignment risk. ` +
          `Current loss: ${fmtUsd(pos.pnl ?? 0, 0, true)}. Consider rolling down-and-out to a lower strike next month to collect fresh premium and buy more time.`
        );
      } else if (belowStrike) {
        const gap = pos.option_strike - (price?.price ?? 0);
        atRiskReasons.set(pos.id,
          `Stock at $${price!.price.toFixed(2)} is $${gap.toFixed(2)} below your $${pos.option_strike} strike. ` +
          `Assignment could happen near expiry. Consider rolling to a lower strike and further expiry to collect more premium.`
        );
      } else if (pnlNegative) {
        atRiskReasons.set(pos.id,
          `Position is currently at a loss of ${fmtUsd(pos.pnl ?? 0, 0, true)}. ` +
          `This is often caused by an IV spike (market fear) rather than the stock moving — the premium inflated. ` +
          `Stock is still above your $${pos.option_strike} strike, so no assignment risk yet. Monitor closely.`
        );
      }

      return (belowStrike || pnlNegative) ? [[...atRiskList, pos], ok] : [atRiskList, [...ok, pos]];
    },
    [[], []]
  );

  const sections = [
    { id: 'positions' as const, label: 'Open', count: openPositions.length },
    { id: 'history' as const, label: 'History', count: closedPositions.length },
    { id: 'watchlist' as const, label: 'Watchlist', count: watchlist.filter(w => w.active).length },
    { id: 'log' as const, label: 'Log', count: activityLog.length },
  ];

  return (
    <div className="space-y-4">
      {/* Refresh */}
      <div className="flex items-center justify-end">
        <button onClick={load} disabled={loading} className="p-1.5 rounded-lg hover:bg-[hsl(var(--muted))] transition-colors">
          <RefreshCw className={cn('w-4 h-4 text-[hsl(var(--muted-foreground))]', loading && 'animate-spin')} />
        </button>
      </div>

      {/* How it works */}
      <HowItWorks />

      {/* Stats Header — income progress + budget meter */}
      {stats && (
        <StatsHeader stats={stats} deployed={deployed} maxAllocation={maxAllocation} openPositions={openPositions} openPrices={openPrices} />
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

      {/* Open Positions — split into Needs Attention / Healthy */}
      {activeSection === 'positions' && (
        <div className="space-y-4">
          {openPositions.length === 0 ? (
            <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">No open options positions</div>
          ) : (
            <>
              {needsAttention.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-bold text-amber-700">⚠️ Needs Attention</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold">
                      {needsAttention.length}
                    </span>
                  </div>
                  {needsAttention.map(pos => (
                    <PositionCard
                      key={pos.id}
                      pos={pos}
                      currentPrice={openPrices.get(pos.ticker)}
                      atRisk
                      atRiskReason={atRiskReasons.get(pos.id)}
                    />
                  ))}
                </div>
              )}

              {healthy.length > 0 && (
                <div className="space-y-2">
                  {needsAttention.length > 0 && (
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-xs font-bold text-emerald-700">✅ Healthy</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold">
                        {healthy.length}
                      </span>
                    </div>
                  )}
                  {healthy.map(pos => (
                    <PositionCard
                      key={pos.id}
                      pos={pos}
                      currentPrice={openPrices.get(pos.ticker)}
                    />
                  ))}
                </div>
              )}
            </>
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
              const isRolled    = pos.close_reason === 'rolled';
              const isStopped   = pos.close_reason === 'stop_loss';
              const isExpired   = pos.close_reason === 'expired_worthless';
              const isProfit    = pos.close_reason === '50pct_profit';
              const is21DteWin  = pos.close_reason === '21dte_profit';
              const is21DteCut  = pos.close_reason === '21dte_close';
              const isEarningsIv = pos.close_reason?.startsWith('earnings_iv_crush') ?? false;
              const histROC = calcAnnualizedROC(pos.pnl, pos.option_capital_req, pos.opened_at, pos.closed_at);

              // Plain-English explanation of why this position was closed
              const closeExplanation = (() => {
                if (isProfit)     return 'Premium decayed to 50% of what was collected — locked in half the max profit early. This frees capital for the next trade and avoids the final weeks of gamma risk.';
                if (isExpired)    return 'Stock stayed above the strike at expiry, so the put expired worthless. Maximum profit kept — the best possible outcome for a put seller.';
                if (isStopped)    return 'Premium rose to 3× the original amount AND the stock was below the strike — real assignment risk. Position closed to limit losses and preserve capital for better setups.';
                if (is21DteWin)   return 'Closed at 21 days to expiry while profitable. Gamma risk accelerates sharply in the final 3 weeks — closing here locks in gains and avoids potential whipsaw from last-minute moves.';
                if (is21DteCut)   return 'Closed at 21 days to expiry even without full profit. Staying in the final 3 weeks exposes the position to elevated gamma risk with little additional reward.';
                if (isRolled)     return pos.notes ?? 'Rolled to a new strike and/or expiry — extended the trade to collect additional premium and avoid or delay assignment.';
                if (isEarningsIv) return 'Earnings IV crush exit — front-month premium collapsed after the announcement. Calendar spread closed at estimated profit.';
                if (pos.option_assigned) return 'Stock was below the strike at or near expiry — assigned the shares. Wheel continues: selling a covered call on the assigned shares to collect more premium.';
                return pos.close_reason?.replace(/_/g, ' ') ?? 'Position closed.';
              })();

              return (
                <div key={pos.id} className={cn(
                  'rounded-xl border p-3 space-y-2',
                  isRolled  ? 'border-blue-200 bg-blue-50' :
                  isStopped ? 'border-red-200 bg-red-50' :
                  'border-[hsl(var(--border))] bg-[hsl(var(--card))]'
                )}>
                  {/* Top row: ticker + badges + P&L */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-bold">{pos.ticker}</span>
                        <span className="text-[10px] px-1 py-0.5 rounded bg-violet-100 text-violet-700">
                          {pos.mode === 'OPTIONS_CALL' ? 'CALL' : 'PUT'}
                        </span>
                        {isRolled    && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">↩️ Rolled</span>}
                        {isStopped   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">🛑 Stopped</span>}
                        {isExpired   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">✅ Expired worthless</span>}
                        {isProfit    && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">💰 50% profit close</span>}
                        {is21DteWin  && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">⏱️ 21 DTE close (profit)</span>}
                        {is21DteCut  && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">⚠️ 21 DTE cut (risk)</span>}
                        {isEarningsIv && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold">📉 IV crush exit</span>}
                        {pos.option_assigned && <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">📌 Assigned</span>}
                      </div>
                      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                        Strike ${pos.option_strike} · Collected ${Math.round((pos.option_premium ?? 0) * (pos.option_contracts ?? 1) * 100)} · Exp {formatExpiry(pos.option_expiry)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={cn('text-sm font-bold', (pos.pnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                        {fmtUsd(pos.pnl ?? 0, 0, true)}
                      </p>
                      {histROC != null && (
                        <p className={cn('text-[10px] font-semibold', histROC >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                          {histROC >= 0 ? '+' : ''}{histROC.toFixed(0)}% ann. ROC
                        </p>
                      )}
                    </div>
                  </div>
                  {/* Why it was closed */}
                  <div className={cn(
                    'rounded-lg px-2.5 py-1.5 text-[10px] leading-relaxed',
                    isStopped  ? 'bg-red-100/70 text-red-800' :
                    is21DteCut ? 'bg-amber-100/70 text-amber-800' :
                    isRolled   ? 'bg-blue-100/70 text-blue-800' :
                    'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
                  )}>
                    <span className="font-semibold">Why closed: </span>{closeExplanation}
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
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Ticker (e.g. SNOW)"
                value={addTicker}
                onChange={e => setAddTicker(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleAddTicker()}
                className="w-28 text-sm px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={addNotes}
                onChange={e => setAddNotes(e.target.value)}
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
          </div>

          {/* Watchlist items */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {watchlist.filter(w => w.active).map(w => {
              const quote = prices.get(w.ticker);
              return (
              <div key={w.id} className="flex flex-col rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 gap-1">
                <div className="flex items-start justify-between gap-1">
                  <div className="flex flex-col min-w-0">
                    <p className="text-sm font-bold text-[hsl(var(--foreground))]">{w.ticker}</p>
                    {quote && (
                      <div className="flex items-baseline gap-1.5 mt-0.5">
                        <span className="text-xs font-semibold tabular-nums text-[hsl(var(--foreground))]">
                          ${quote.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                        <span className={cn(
                          'text-[10px] font-medium tabular-nums',
                          quote.changePercent >= 0 ? 'text-emerald-600' : 'text-red-500'
                        )}>
                          {quote.changePercent >= 0 ? '+' : ''}{quote.changePercent.toFixed(2)}%
                        </span>
                      </div>
                    )}
                    {!quote && <span className="text-[10px] text-[hsl(var(--muted-foreground))]/40 tabular-nums">—</span>}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      title="Edit description"
                      onClick={() => {
                        setEditingNotes(w.ticker);
                        setEditNotesValue(w.notes ?? '');
                      }}
                      className="p-1 rounded hover:bg-[hsl(var(--muted))] transition-colors"
                    >
                      <Pencil className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
                    </button>
                    <button
                      onClick={() => handleRemoveTicker(w.ticker)}
                      className="p-1 rounded hover:bg-[hsl(var(--muted))] transition-colors"
                    >
                      <X className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
                    </button>
                  </div>
                </div>

                {editingNotes === w.ticker ? (
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      type="text"
                      value={editNotesValue}
                      onChange={e => setEditNotesValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSaveNotes(w.ticker);
                        if (e.key === 'Escape') setEditingNotes(null);
                      }}
                      placeholder="Add description..."
                      className="flex-1 text-[11px] px-2 py-1 rounded border border-violet-300 bg-[hsl(var(--background))] focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                    <button
                      onClick={() => handleSaveNotes(w.ticker)}
                      className="p-1 rounded bg-violet-100 hover:bg-violet-200 transition-colors"
                    >
                      <Check className="w-3 h-3 text-violet-700" />
                    </button>
                  </div>
                ) : (
                  <p className={cn(
                    'text-[10px] leading-snug',
                    w.notes ? 'text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--muted-foreground))]/40 italic'
                  )}>
                    {w.notes ?? 'no description'}
                  </p>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
