import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, AlertTriangle, CheckCircle, Activity, Pencil, Check, TrendingUp, DollarSign, Crosshair, Search, Loader2, Send, Trash2 } from 'lucide-react';
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
  getOpenCreditSpreads,
  getClosedCreditSpreads,
  getOpenScalpTrades,
  getClosedScalpTrades,
  type TickerQuote,
  type WatchlistTicker,
  type OpenOptionsPosition,
  type OptionsMonthlyStats,
  type OptionsActivityEvent,
  type CreditSpreadPosition,
  type ScalpTrade,
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
  onSubmitToIB,
  onDiscard,
}: {
  pos: OpenOptionsPosition;
  currentPrice?: TickerQuote;
  atRisk?: boolean;
  atRiskReason?: string;
  onSubmitToIB?: (id: string) => Promise<void>;
  onDiscard?: (id: string) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const handleSubmit = async () => {
    if (!onSubmitToIB) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmitToIB(pos.id);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscard = async () => {
    if (!onDiscard) return;
    setDiscarding(true);
    try {
      await onDiscard(pos.id);
    } finally {
      setDiscarding(false);
    }
  };
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
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-[hsl(var(--foreground))]">{pos.ticker}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">
            {pos.mode === 'OPTIONS_CALL' ? 'CALL' : 'PUT'}
          </span>
          {pos.ib_order_id && pos.status === 'SUBMITTED' ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
              ⏳ Pending #{pos.ib_order_id}
            </span>
          ) : pos.ib_order_id ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
              ✓ IB #{pos.ib_order_id}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
              Paper only
            </span>
          )}
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

      {/* Submit to IB / Discard — only shown for paper-only positions */}
      {!pos.ib_order_id && (onSubmitToIB || onDiscard) && (
        <div className="mt-2 space-y-1">
          <div className="flex gap-1.5">
            {onSubmitToIB && (
              <button
                onClick={handleSubmit}
                disabled={submitting || discarding}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-[11px] font-semibold hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                {submitting ? 'Submitting…' : 'Submit to IB'}
              </button>
            )}
            {onDiscard && (
              <button
                onClick={handleDiscard}
                disabled={discarding || submitting}
                title="Discard — remove this paper trade without submitting to IB"
                className="flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 text-[11px] font-semibold hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {discarding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                {discarding ? '' : 'Discard'}
              </button>
            )}
          </div>
          {submitError && (
            <p className="text-[10px] text-red-600 text-center">{submitError}</p>
          )}
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

// ── Options Playbook (tabbed — replaces 8 stacked cards) ─

type PlaybookTab = 'strategies' | 'mechanics' | 'rules';

function OptionsPlaybook() {
  const [tab, setTab] = useState<PlaybookTab>('strategies');

  const tabs: { id: PlaybookTab; label: string; desc: string }[] = [
    { id: 'strategies', label: '⚡ Strategies', desc: 'Wheel · Scalp · LEAPs' },
    { id: 'mechanics', label: '📐 Mechanics', desc: 'Greeks · Strikes · IV' },
    { id: 'rules',     label: '🚨 Rules',      desc: 'Survival & playbook' },
  ];

  return (
    <div className="space-y-3">
      {/* Tab pills */}
      <div className="flex gap-1.5 bg-[hsl(var(--muted))]/50 p-1 rounded-xl">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg text-center transition-colors',
              tab === t.id
                ? 'bg-[hsl(var(--card))] shadow-sm'
                : 'hover:bg-[hsl(var(--muted))]',
            )}
          >
            <span className={cn('text-[11px] font-bold', tab === t.id ? 'text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]')}>{t.label}</span>
            <span className="text-[9px] text-[hsl(var(--muted-foreground))]">{t.desc}</span>
          </button>
        ))}
      </div>

      {/* Strategies tab */}
      {tab === 'strategies' && (
        <div className="space-y-3">
          <OptionsScalpGuide />
          <WheelPlaybook />
          <LeapsGuide />
        </div>
      )}

      {/* Mechanics tab */}
      {tab === 'mechanics' && (
        <div className="space-y-3">
          <StrikeSelectionGuide />
          <GreeksReference />
          <SmartSellingGuide />
        </div>
      )}

      {/* Rules tab */}
      {tab === 'rules' && (
        <div className="space-y-3">
          <OptionsSurvivalRules />
        </div>
      )}
    </div>
  );
}

// ── Options Survival Rules ────────────────────────────────

const SURVIVAL_RULES = [
  {
    n: '1',
    title: 'Sell, don\'t just buy',
    color: 'border-emerald-200 bg-emerald-50/60 text-emerald-800',
    num: 'bg-emerald-200 text-emerald-800',
    desc: 'Most options expire worthless. If you\'re only buying, the math works against you. Sell options and let theta pay you every single day.',
    tag: 'Theta works FOR you',
    tagColor: 'bg-emerald-100 text-emerald-700',
  },
  {
    n: '2',
    title: 'Stop buying short-dated options',
    color: 'border-red-200 bg-red-50/60 text-red-800',
    num: 'bg-red-200 text-red-800',
    desc: 'The closer to expiration, the faster theta decays. If you\'re going to buy, buy LEAPs — 1 year or more. Time becomes your ally instead of your enemy.',
    tag: 'Buy time, not lottery tickets',
    tagColor: 'bg-red-100 text-red-700',
  },
  {
    n: '3',
    title: 'Sell puts on stocks you\'d own',
    color: 'border-blue-200 bg-blue-50/60 text-blue-800',
    num: 'bg-blue-200 text-blue-800',
    desc: 'Get paid premium while you wait for your price. If assigned, you bought at a discount and kept the premium. If not — keep the cash and repeat.',
    tag: 'The Wheel',
    tagColor: 'bg-blue-100 text-blue-700',
  },
  {
    n: '4',
    title: 'Use charts before every trade',
    color: 'border-violet-200 bg-violet-50/60 text-violet-800',
    num: 'bg-violet-200 text-violet-800',
    desc: 'RSI, support levels, moving averages. A good strategy with a bad entry is still a losing trade. The scanner checks RSI, SMA20, Bollinger Bands, and MACD before every options trade.',
    tag: 'Entry matters',
    tagColor: 'bg-violet-100 text-violet-700',
  },
  {
    n: '5',
    title: 'Collect singles, don\'t swing for homers',
    color: 'border-amber-200 bg-amber-50/60 text-amber-800',
    num: 'bg-amber-200 text-amber-800',
    desc: 'Long-term survivors aren\'t hitting home runs — they\'re managing risk and letting the framework do the work. 50% profit-take, defined stop-loss, repeat.',
    tag: 'Let the system work',
    tagColor: 'bg-amber-100 text-amber-700',
  },
];

function OptionsSurvivalRules() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/40 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-rose-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-rose-700">🚨 5 Rules to Stop Losing Money on Options</span>
        </div>
        <span className="text-[10px] text-rose-400">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-rose-100 px-4 py-3 space-y-2">
          {SURVIVAL_RULES.map((rule) => (
            <div key={rule.n} className={`rounded-xl border px-3 py-2.5 flex gap-3 ${rule.color}`}>
              <span className={`text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${rule.num}`}>{rule.n}</span>
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-bold">{rule.title}</span>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${rule.tagColor}`}>{rule.tag}</span>
                </div>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">{rule.desc}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Options Scalp Guide ───────────────────────────────────

function OptionsScalpGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-sky-100 bg-sky-50/50 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-sky-50 transition-colors"
      >
        <span className="text-xs font-semibold text-sky-700">⚡ Options Scalp — ATM Buying Strategy</span>
        <span className="text-[10px] text-sky-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-sky-100 px-4 py-3 space-y-3">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            <strong className="text-sky-700">OPTIONS_SCALP</strong> is an intraday directional strategy — we <em>buy</em> ATM calls or puts for same-day moves. Completely separate from the wheel (which sells options). Think of the wheel as the income engine; scalps are high-conviction momentum punches.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { icon: '🎯', title: 'ATM Only', desc: 'Buy the strike closest to current stock price (~0.40–0.60 delta). No need to worry about Greeks when you\'re ATM — the option moves nearly dollar-for-dollar with the stock.' },
              { icon: '📊', title: '1.5% Move Required', desc: 'Stock must be up or down >1.5% from the open before we enter. This confirms momentum is real, not just noise.' },
              { icon: '💧', title: 'Liquidity Filter', desc: 'Round-dollar strikes only (no $82.50 "beta contracts"). Minimum real bid required. Market order only when bid-ask spread is tight (<3%).' },
              { icon: '📅', title: 'Weekly Expiry', desc: 'Nearest Friday expiry (at least 1 day out). Weekly options have high gamma — small stock moves = big % option gains intraday.' },
              { icon: '✅', title: 'Take Profit: +100%', desc: 'When the premium doubles (option price 2× what you paid), auto-close. Don\'t get greedy.' },
              { icon: '🛑', title: 'Stop Loss: −50%', desc: 'When premium halves (you\'re down 50%), auto-close. Max loss is defined and capped upfront.' },
              { icon: '⏰', title: 'EOD Hard Close', desc: 'All scalp positions close at 3:45 PM ET regardless. Options decay fastest in the last 30 min — never hold overnight.' },
              { icon: '🔢', title: 'Position Sizing', desc: 'Max 1 contract per trade, max 2 scalp trades per day, $500 max premium per trade. Small and disciplined.' },
            ].map((item, i) => (
              <div key={i} className="flex gap-2 bg-white/60 rounded-lg px-3 py-2 border border-sky-100">
                <span className="text-base shrink-0 mt-0.5">{item.icon}</span>
                <div className="space-y-0.5">
                  <div className="text-[11px] font-bold text-sky-800">{item.title}</div>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Wheel Playbook ────────────────────────────────────────

function WheelPlaybook() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-emerald-50 transition-colors"
      >
        <span className="text-xs font-semibold text-emerald-700">🎡 Wheel Playbook — Full Framework</span>
        <span className="text-[10px] text-emerald-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-emerald-100 px-4 py-3 space-y-3">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            The wheel is simple but the edge is in the <em>timing</em>. Pair it with technical indicators and you collect premium on stocks you actually want to own.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { icon: '🔴', title: 'Sell Puts on Red Days', desc: 'Fear = expensive puts = more premium. Sell cash-secured puts on pullbacks in stocks you\'d happily own. If assigned, you bought at a discount plus kept the premium.' },
              { icon: '🟢', title: 'Close Puts on Green Days', desc: 'When your sold put is up 50%+ and the stock rips, buy it back. Don\'t wait for full expiry — lock gains, free capital, redeploy.' },
              { icon: '📈', title: 'Sell Calls on Your Shares', desc: 'Once assigned, sell covered calls above your cost basis. Collect more premium while waiting for the stock to recover.' },
              { icon: '📐', title: 'Mix in Technicals', desc: 'Bollinger Bands (squeeze = low IV, expansion = high IV), RSI (<30 = oversold put opportunity), MACD (confirm trend direction), S/R levels (sell puts above support).' },
              { icon: '⏳', title: 'DTE Targeting', desc: 'Sell 7–42 DTE for fast theta decay. The sweet spot is 21–30 DTE — theta accelerates sharply in the last 30 days. Take profit at 50% and roll.' },
              { icon: '🎯', title: 'Delta 0.15–0.25', desc: '~80–85% probability of keeping the full premium. Not zero-risk, but favorable odds. The stock needs to drop hard to assign you — and if it does, you wanted to own it anyway.' },
              { icon: '🧺', title: 'Base Portfolio', desc: 'Only wheel stocks you\'d hold long-term: NVDA, AMD, AAPL, GOOG, AMZN, TSLA, META, MU. Never wheel a stock you\'d panic-sell if assigned.' },
              { icon: '🧘', title: 'Patience is the Edge', desc: 'Most premium sellers lose because they panic-close losers or chase high-IV trash. Stick to quality names, respect your strikes, and let theta do the work.' },
            ].map((item, i) => (
              <div key={i} className="flex gap-2 bg-white/60 rounded-lg px-3 py-2 border border-emerald-100">
                <span className="text-base shrink-0 mt-0.5">{item.icon}</span>
                <div className="space-y-0.5">
                  <div className="text-[11px] font-bold text-emerald-800">{item.title}</div>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Greeks Reference ──────────────────────────────────────

const GREEKS = [
  {
    symbol: 'Δ',
    name: 'Delta',
    color: 'text-blue-700',
    bg: 'bg-blue-50 border-blue-100',
    desc: 'How much the option moves per $1 stock move. 0.50 delta = option gains $0.50 when stock moves $1.',
    tip: 'Also a rough probability estimate. Sell at 0.15–0.25 delta (~80% chance of keeping premium). Buy ATM scalps at 0.40–0.60.',
  },
  {
    symbol: 'Θ',
    name: 'Theta',
    color: 'text-emerald-700',
    bg: 'bg-emerald-50 border-emerald-100',
    desc: 'Daily time decay — how much value your option loses each day just from time passing.',
    tip: 'When you SELL options, theta pays you every day. When you BUY, it bleeds you. Accelerates hard inside 30 DTE.',
  },
  {
    symbol: 'Γ',
    name: 'Gamma',
    color: 'text-orange-700',
    bg: 'bg-orange-50 border-orange-100',
    desc: 'How fast delta changes as the stock moves. High gamma = delta shifts quickly = more volatile position.',
    tip: 'Matters most for short-dated ATM options. High gamma is why weekly scalps can double quickly on a big move.',
  },
  {
    symbol: 'V',
    name: 'Vega',
    color: 'text-violet-700',
    bg: 'bg-violet-50 border-violet-100',
    desc: 'How much the option price changes when implied volatility (IV) moves 1 point.',
    tip: 'High IV = expensive options → good for selling (wheel). Low IV = cheap options → good for buying LEAPs. Check IV rank before every trade.',
  },
  {
    symbol: 'ρ',
    name: 'Rho',
    color: 'text-slate-600',
    bg: 'bg-slate-50 border-slate-100',
    desc: 'How much the option price changes when interest rates move.',
    tip: 'Least impactful for most retail trades. Matters more for deep ITM LEAPs with long expirations.',
  },
];

function GreeksReference() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/40 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="text-xs font-semibold text-slate-700">📐 The Greeks — Quick Reference</span>
        <span className="text-[10px] text-slate-400">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-2">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            You don't need a PhD in the Greeks — but understanding these five will immediately make you a better options trader.
            The two that matter most: <strong className="text-emerald-700">Theta</strong> (why we sell) and <strong className="text-violet-700">Vega</strong> (check IV before every trade).
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {GREEKS.map((g) => (
              <div key={g.name} className={`rounded-xl border px-3 py-2.5 space-y-1.5 ${g.bg}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-lg font-bold font-mono leading-none ${g.color}`}>{g.symbol}</span>
                  <span className={`text-[11px] font-bold ${g.color}`}>{g.name}</span>
                </div>
                <p className="text-[10px] text-[hsl(var(--foreground))] leading-relaxed">{g.desc}</p>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed border-t border-current/10 pt-1.5">{g.tip}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Strike Selection Guide ────────────────────────────────

function StrikeSelectionGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-indigo-50 transition-colors"
      >
        <span className="text-xs font-semibold text-indigo-700">📍 How to Pick Your Strike — ITM / ATM / OTM</span>
        <span className="text-[10px] text-indigo-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-indigo-100 px-4 py-3 space-y-3">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            Strike selection is the single biggest lever on your risk/reward. Each zone has a different tradeoff between cost, probability, and leverage.
          </p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              {
                label: 'ITM',
                full: 'In the Money',
                color: 'border-emerald-200 bg-emerald-50/60',
                hdr: 'text-emerald-700',
                tag: 'Most Conservative',
                tagColor: 'bg-emerald-100 text-emerald-700',
                delta: 'δ 0.60–0.80',
                points: [
                  'Moves closely with the stock (high delta)',
                  'Highest probability of profit',
                  'Less leverage — costs more upfront',
                  'Best for: LEAPs (12+ month calls on conviction names)',
                ],
              },
              {
                label: 'ATM',
                full: 'At the Money',
                color: 'border-sky-200 bg-sky-50/60',
                hdr: 'text-sky-700',
                tag: 'Middle Ground',
                tagColor: 'bg-sky-100 text-sky-700',
                delta: 'δ 0.40–0.60',
                points: [
                  'Balanced cost, leverage, and probability',
                  'Gamma is highest — biggest % moves intraday',
                  'Best for: Options Scalp (same-day directional plays)',
                  'No need to fight the Greeks — the option tracks the stock',
                ],
              },
              {
                label: 'OTM',
                full: 'Out of the Money',
                color: 'border-red-200 bg-red-50/60',
                hdr: 'text-red-700',
                tag: '~10% OTM',
                tagColor: 'bg-red-100 text-red-700',
                delta: 'δ 0.15–0.30',
                points: [
                  'Cheapest premium — but needs a big move to profit',
                  'Lowest probability of profit when BUYING',
                  'Best for: Wheel — SELLING puts far below the stock',
                  '⚠️ Don\'t confuse cheap with a good deal',
                ],
              },
            ].map((zone) => (
              <div key={zone.label} className={`rounded-xl border px-3 py-3 space-y-2 ${zone.color}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-base font-bold ${zone.hdr}`}>{zone.label}</span>
                    <span className={`text-[10px] font-medium ${zone.hdr}`}>{zone.full}</span>
                  </div>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${zone.tagColor}`}>{zone.tag}</span>
                </div>
                <div className={`text-[10px] font-mono font-semibold ${zone.hdr}`}>{zone.delta}</div>
                <ul className="space-y-1">
                  {zone.points.map((pt, i) => (
                    <li key={i} className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed flex gap-1.5">
                      <span className="shrink-0 mt-0.5">·</span>
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
            <p className="text-[11px] text-amber-800 font-semibold">How this system uses each zone:</p>
            <div className="mt-1.5 space-y-1 text-[10px] text-[hsl(var(--muted-foreground))]">
              <div>🎯 <strong>Options Scalp</strong> → always ATM (δ 0.40–0.60). Maximum gamma for intraday moves.</div>
              <div>🎡 <strong>Wheel (selling puts)</strong> → OTM at δ 0.15–0.30 in normal IV; bumped to δ 0.30–0.35 in high IV.</div>
              <div>📈 <strong>LEAPs (future)</strong> → ITM or ATM (δ 0.60–0.80). 12+ months, buy time, minimize theta bleed.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Smart Selling Guide ───────────────────────────────────

function SmartSellingGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50/40 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-amber-50 transition-colors"
      >
        <span className="text-xs font-semibold text-amber-700">🧠 Smart Selling — Delta & Vega in Practice</span>
        <span className="text-[10px] text-amber-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-amber-100 px-4 py-3 space-y-3">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            Delta and Vega work together. The IV environment determines <em>which</em> delta to target — mastering this relationship is what separates consistent premium collectors from gamblers.
          </p>

          {/* IV rule cards */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-red-200 bg-red-50/60 px-3 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🔥</span>
                <span className="text-[11px] font-bold text-red-700">High IV Environment</span>
              </div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">
                Options are expensive. Sell <strong>higher delta (0.30–0.40, ATM/ITM)</strong> to collect fat premium. IV crush after the event will shrink option value fast — even if the stock barely moves, you win from IV compression.
              </p>
              <div className="rounded-lg bg-red-100/60 px-2 py-1.5">
                <p className="text-[10px] text-red-700 font-medium">⚠️ Exception: Never sell high-delta during earnings. IV spikes going in but the move can blow through any strike.</p>
              </div>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 px-3 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🧊</span>
                <span className="text-[11px] font-bold text-blue-700">Low IV Environment</span>
              </div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">
                Options are cheap. Sell <strong>lower delta (0.15–0.25, OTM)</strong> — less premium but also much less risk. Higher probability of keeping full premium. This is the default wheel mode: patience over aggression.
              </p>
              <div className="rounded-lg bg-blue-100/60 px-2 py-1.5">
                <p className="text-[10px] text-blue-700 font-medium">💡 Low IV is also the signal to <em>buy</em> LEAPs — options are on sale, so go long with a 12+ month expiry on your highest-conviction names.</p>
              </div>
            </div>
          </div>

          {/* Delta-Vega tradeoff table */}
          <div className="rounded-xl border border-amber-100 overflow-hidden">
            <div className="bg-amber-50 px-3 py-2 border-b border-amber-100">
              <span className="text-[10px] font-bold text-amber-700">Delta ↔ Vega Tradeoff</span>
            </div>
            <div className="divide-y divide-amber-50">
              {[
                { delta: 'High (0.30–0.50)', vega: 'Low', ivRisk: 'Less', premium: 'More', prob: 'Lower', when: 'High IV only' },
                { delta: 'Low (0.10–0.25)', vega: 'High', ivRisk: 'More', premium: 'Less', prob: 'Higher', when: 'Normal / Low IV' },
              ].map((row, i) => (
                <div key={i} className="grid grid-cols-6 text-[10px] px-3 py-2 gap-1">
                  <span className="font-semibold text-[hsl(var(--foreground))]">{row.delta}</span>
                  <span className="text-[hsl(var(--muted-foreground))]">Vega: {row.vega}</span>
                  <span className="text-[hsl(var(--muted-foreground))]">IV Risk: {row.ivRisk}</span>
                  <span className="text-emerald-700 font-medium">+Premium: {row.premium}</span>
                  <span className="text-[hsl(var(--muted-foreground))]">Prob: {row.prob}</span>
                  <span className="text-amber-700 font-semibold">{row.when}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            The wheel scanner already checks <strong>IV rank</strong> before selecting a strike. In high-IV conditions it targets 0.30 delta; in normal conditions it targets 0.20 delta. This is the same framework — automated.
          </p>
        </div>
      )}
    </div>
  );
}

// ── LEAPs Guide ───────────────────────────────────────────

const LEAP_CONCEPTS = [
  {
    n: '1', title: 'What is a LEAP?',
    desc: 'A call option with at least 1 year until expiration. You\'re buying the right to own 100 shares at a set price. Time is the edge — you control 100 shares for 20–25% of the capital cost.',
  },
  {
    n: '2', title: 'Intrinsic vs Extrinsic Value',
    desc: 'Intrinsic = how far in the money you are. Extrinsic = the time premium you\'re paying. Know what you\'re buying before you enter. Deep ITM LEAPs are mostly intrinsic — they track the stock closely.',
  },
  {
    n: '3', title: 'Delta — go deep ITM',
    desc: 'Deep ITM (δ 0.70–0.80) = moves almost dollar-for-dollar with the stock. Less leverage but highest probability. OTM = cheap premium but needs a massive move. Don\'t confuse cheap with a good deal.',
  },
  {
    n: '4', title: 'Theta Decay — why 1+ year matters',
    desc: 'Time decay accelerates near expiration. 1+ year out means daily theta bleed is tiny. The further out you go, the slower the decay. Never buy a LEAP under 1 year.',
  },
  {
    n: '5', title: 'IV & IV Crush — buy when cheap',
    desc: 'High implied volatility = expensive premiums. Buy LEAPs when IV rank is low (<40). Never buy before earnings or a major event — IV spikes going in and crushes after, eating your premium.',
  },
  {
    n: '6', title: 'Strike Selection',
    desc: 'Deep ITM (δ 0.70–0.80) for safety and stock-like returns. ATM (δ 0.50) for balance. One strike OTM for asymmetric upside on high conviction. Match the strike to your conviction level.',
  },
  {
    n: '7', title: 'Break-Even Price',
    desc: 'Strike + premium paid = break-even at expiration. But most LEAP profits are taken well before expiry. You don\'t need to hold to the end — take profits when the thesis plays out.',
  },
  {
    n: '8', title: 'Position Sizing — max 10%',
    desc: 'LEAPs are leveraged. Size like you could lose the entire premium. Never put more than 10% of your total portfolio in LEAPs combined. One bad position shouldn\'t set you back months.',
  },
  {
    n: '9', title: 'When to Enter',
    desc: 'Key support levels or oversold RSI conditions. Not at all-time highs. Not the day before earnings. Patience on entry is half the trade — the scanner waits for RSI < 55 and below 52w high.',
  },
  {
    n: '10', title: 'When to Exit',
    desc: 'If the thesis breaks, get out (−20% stock move triggers auto-close). If thesis is intact and you\'re winning, let it work. If DTE < 90 days, make a plan early. Don\'t let a winner turn into a loss.',
  },
];

function LeapsGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/40 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-teal-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-teal-700">📅 LEAPs — 10 Concepts Before You Buy</span>
          <span className="text-[9px] font-bold bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded-full">ACTIVE</span>
        </div>
        <span className="text-[10px] text-teal-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="border-t border-teal-100 px-4 py-3 space-y-3">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            LEAPs are the best way for an average investor to grow wealth exponentially — but only when you understand what you're buying.
            Without conviction, patience, and discipline, they're just expensive lottery tickets.
            The scanner enters when <strong className="text-teal-700">IV rank &lt; 40</strong>, <strong className="text-teal-700">RSI &lt; 55</strong>,
            no earnings within 14 days, and stock is not near its 52-week high.
          </p>

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {LEAP_CONCEPTS.map((c) => (
              <div key={c.n} className="flex gap-2.5 bg-white/60 rounded-lg px-3 py-2 border border-teal-100">
                <span className="text-[10px] font-bold w-4 h-4 rounded-full bg-teal-100 text-teal-800 flex items-center justify-center shrink-0 mt-0.5">{c.n}</span>
                <div className="space-y-0.5">
                  <div className="text-[11px] font-bold text-teal-800">{c.title}</div>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))] leading-relaxed">{c.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2.5 space-y-1">
            <p className="text-[10px] font-bold text-teal-700">How this system trades LEAPs:</p>
            <div className="space-y-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
              <div>📅 <strong>Scan:</strong> Every Monday 10:30 AM — HIGH_VOL + GROWTH watchlist tickers</div>
              <div>🎯 <strong>Strike:</strong> Deep ITM call at δ 0.70–0.80 · expiry ~12–18 months out</div>
              <div>✅ <strong>Take profit:</strong> Premium doubles (+100%) → auto-close</div>
              <div>🛑 <strong>Thesis break:</strong> Stock drops &gt;20% from entry → auto-close</div>
              <div>⚠️ <strong>DTE alert:</strong> Under 90 days → warning fires to roll or close</div>
              <div>💼 <strong>Portfolio cap:</strong> Total LEAP exposure capped at 10% of account ($10k on $100k)</div>
            </div>
          </div>
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
  // Unrealized P&L across all open positions (negative = premium moved against us)
  const totalUnrealizedPnl = openPositions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  // Progress = realized + premium in play vs monthly target
  // (premium in play = cash already collected from open positions, kept if they expire OTM)
  const potentialIncome = stats.premiumCollected + stats.openPremiumAtRisk;
  const netProgress = Math.min(Math.max(potentialIncome, 0) / MONTHLY_INCOME_TARGET, 1);
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
            Target: <span className="font-semibold">{fmtUsd(MONTHLY_INCOME_TARGET, 0)}</span>/mo
          </span>
        </div>

        {/* Premium in play — the primary number for a premium seller */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-emerald-100/80 px-3 py-2">
            <p className="text-[9px] text-emerald-600 font-medium uppercase tracking-wide">Premium in Play</p>
            <p className="text-sm font-bold text-emerald-800">{fmtUsd(stats.openPremiumAtRisk, 0)}</p>
            <p className="text-[9px] text-emerald-600">{stats.openPositions} open position{stats.openPositions !== 1 ? 's' : ''}</p>
          </div>
          <div className="rounded-lg bg-white/70 px-3 py-2">
            <p className="text-[9px] text-[hsl(var(--muted-foreground))] font-medium uppercase tracking-wide">Realized</p>
            <p className={cn('text-sm font-bold', stats.premiumCollected >= 0 ? 'text-emerald-800' : 'text-red-700')}>
              {fmtUsd(stats.premiumCollected, 0, true)}
            </p>
            <p className="text-[9px] text-[hsl(var(--muted-foreground))]">
              {stats.wins}W / {stats.losses}L
              {stats.expiredWorthless > 0 && <span className="ml-1 text-emerald-600">· {stats.expiredWorthless} expired ✓</span>}
            </p>
          </div>
          <div className="rounded-lg bg-white/70 px-3 py-2">
            <p className="text-[9px] text-[hsl(var(--muted-foreground))] font-medium uppercase tracking-wide">Cost to Close Now</p>
            <p className={cn('text-sm font-bold', totalUnrealizedPnl >= 0 ? 'text-emerald-800' : 'text-amber-700')}>
              {fmtUsd(totalUnrealizedPnl, 0, true)}
            </p>
            <p className="text-[9px] text-[hsl(var(--muted-foreground))]">MTM vs collected</p>
          </div>
        </div>

        {/* Scalp P&L row — only shown if there are scalp trades */}
        {stats.scalpTrades > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-sky-50 border border-sky-100 px-3 py-1.5">
            <span className="text-[10px] font-semibold text-sky-700">⚡ Scalp P&L</span>
            <span className={cn('text-[10px] font-bold', stats.scalpPnl >= 0 ? 'text-emerald-700' : 'text-red-600')}>
              {fmtUsd(stats.scalpPnl, 0, true)}
            </span>
            <span className="text-[9px] text-sky-500">({stats.scalpTrades} trade{stats.scalpTrades !== 1 ? 's' : ''})</span>
          </div>
        )}

        {/* Progress toward target */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-emerald-700">
              Potential this month: <span className="font-semibold">{fmtUsd(stats.premiumCollected + stats.openPremiumAtRisk, 0)}</span>
              <span className="text-[hsl(var(--muted-foreground))] ml-1">(realized + in play)</span>
            </span>
            <span className={cn('font-bold', netProgress > 0.5 ? 'text-emerald-700' : netProgress > 0.25 ? 'text-amber-600' : 'text-red-600')}>
              {netProgressPct}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-emerald-100 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${netProgressPct}%` }}
            />
          </div>
        </div>

        {stats.annualizedReturn > 0 && (
          <p className="text-[10px] text-emerald-600">{stats.annualizedReturn.toFixed(0)}% annualized on deployed capital</p>
        )}
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

// ── Credit Spread Card ────────────────────────────────────

function SpreadCard({ spread, closed }: { spread: CreditSpreadPosition; closed?: boolean }) {
  const dte = spread.option_expiry ? daysUntil(spread.option_expiry) : 0;
  const totalCredit = (spread.spread_net_credit ?? 0) * 100 * (spread.option_contracts ?? 1);
  const creditPctDisplay = ((spread.spread_credit_pct ?? 0) * 100).toFixed(0);
  const pnl = spread.pnl ?? 0;
  const maxGain = spread.spread_max_gain ?? totalCredit;
  const pnlPctOfMax = maxGain > 0 ? (pnl / maxGain) * 100 : 0;

  const borderClass = closed
    ? pnl >= 0 ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/40'
    : dte <= 21 ? 'border-amber-200 bg-amber-50' : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]';

  return (
    <div className={cn('rounded-xl border p-3', borderClass)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[hsl(var(--foreground))]">{spread.ticker}</span>
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-medium',
            spread.spread_type === 'BULL_PUT'
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-red-100 text-red-700'
          )}>
            {spread.spread_type === 'BULL_PUT' ? 'Bull Put' : 'Bear Call'}
          </span>
          {closed && spread.close_reason && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
              {spread.close_reason.replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!closed && (
            <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-semibold', dteBadgeColor(dte))}>
              {dte}d left
            </span>
          )}
          <span className={cn(
            'text-[10px] px-2 py-0.5 rounded-full font-semibold',
            pnl >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
          )}>
            {fmtUsd(pnl, 0, true)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 text-center">
        <div>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">
            ${spread.spread_short_strike}/{spread.spread_long_strike}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Strikes</p>
        </div>
        <div>
          <p className="text-xs font-bold text-emerald-600">
            +${totalCredit.toFixed(0)}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Credit</p>
        </div>
        <div>
          <p className="text-xs font-bold text-violet-700">
            {creditPctDisplay}%
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Cr/Width</p>
        </div>
        <div>
          <p className="text-xs font-bold text-red-600">
            ${(spread.spread_max_loss ?? 0).toFixed(0)}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Max Risk</p>
        </div>
        <div>
          <p className="text-xs font-bold text-[hsl(var(--foreground))]">
            {spread.option_expiry ? formatExpiry(spread.option_expiry) : '—'}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Expiry</p>
        </div>
      </div>

      {/* Progress towards max gain */}
      {!closed && maxGain > 0 && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] text-[hsl(var(--muted-foreground))] mb-1">
            <span>P&L: {pnlPctOfMax.toFixed(0)}% of max</span>
            <span>Target: 50%</span>
          </div>
          <div className="h-1.5 rounded-full bg-[hsl(var(--muted))]/40 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', pnl >= 0 ? 'bg-emerald-500' : 'bg-red-400')}
              style={{ width: `${Math.min(100, Math.abs(pnlPctOfMax))}%` }}
            />
          </div>
        </div>
      )}

      {spread.scanner_reason && (
        <p className="mt-2 text-[10px] text-[hsl(var(--muted-foreground))] leading-snug">
          {spread.scanner_reason}
        </p>
      )}
    </div>
  );
}

// ── Scalp Card ───────────────────────────────────────────

function ScalpCard({ scalp, closed }: { scalp: ScalpTrade; closed?: boolean }) {
  const isCall = scalp.notes?.toLowerCase().includes('call') ?? false;
  const side = isCall ? 'CALL' : 'PUT';
  const premium = scalp.option_premium ?? 0;
  const contracts = scalp.option_contracts ?? 1;
  const totalPaid = premium * contracts * 100;
  const pnl = scalp.pnl ?? 0;
  const pnlPct = totalPaid > 0 ? (pnl / totalPaid) * 100 : null;

  const isWin  = pnl > 0;
  const isLoss = pnl < 0;
  const isOpen = !closed;

  const borderClass = closed
    ? isWin  ? 'border-emerald-200 bg-emerald-50/40'
    : isLoss ? 'border-red-200 bg-red-50/40'
    : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]'
    : 'border-sky-200 bg-sky-50/40';

  const closeLabel = (() => {
    switch (scalp.close_reason) {
      case 'eod_close':    return '🌙 EOD close';
      case 'stop_loss':    return '🛑 Stop loss';
      case '50pct_profit': return '💰 50% profit';
      case 'no_fill':      return '❌ No fill';
      default: return scalp.close_reason?.replace(/_/g, ' ') ?? null;
    }
  })();

  return (
    <div className={cn('rounded-xl border p-3', borderClass)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold">{scalp.ticker}</span>
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-semibold',
            isCall ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
          )}>
            {side}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-medium">⚡ Scalp</span>
          {isOpen && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold animate-pulse">● Live</span>}
          {closed && closeLabel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">{closeLabel}</span>
          )}
        </div>
        <div className="text-right shrink-0">
          {closed ? (
            <>
              <p className={cn('text-sm font-bold', isWin ? 'text-emerald-600' : isLoss ? 'text-red-600' : 'text-[hsl(var(--muted-foreground))]')}>
                {fmtUsd(pnl, 0, true)}
              </p>
              {pnlPct != null && (
                <p className={cn('text-[10px] font-semibold', isWin ? 'text-emerald-600' : 'text-red-600')}>
                  {isWin ? '+' : ''}{pnlPct.toFixed(0)}% on cost
                </p>
              )}
            </>
          ) : (
            <p className="text-[10px] text-sky-600 font-semibold">
              Cost ${totalPaid.toFixed(0)}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1 text-center">
        <div>
          <p className="text-xs font-bold">${scalp.option_strike}</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Strike</p>
        </div>
        <div>
          <p className="text-xs font-bold">${premium.toFixed(2)}</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Premium</p>
        </div>
        <div>
          <p className="text-xs font-bold">{contracts}x</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Contracts</p>
        </div>
        <div>
          <p className="text-xs font-bold">{scalp.option_expiry ? formatExpiry(scalp.option_expiry) : '—'}</p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Expiry</p>
        </div>
      </div>

      {scalp.scanner_reason && (
        <p className="mt-2 text-[10px] text-[hsl(var(--muted-foreground))] leading-snug">{scalp.scanner_reason}</p>
      )}
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
  const [scanning, setScanning] = useState(false);
  const [addTicker, setAddTicker] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addingTicker, setAddingTicker] = useState(false);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [editNotesValue, setEditNotesValue] = useState('');
  const [prices, setPrices] = useState<Map<string, TickerQuote>>(new Map());
  const [openPrices, setOpenPrices] = useState<Map<string, TickerQuote>>(new Map());
  const [maxAllocation, setMaxAllocation] = useState<number>(500_000);
  const [openSpreads, setOpenSpreads] = useState<CreditSpreadPosition[]>([]);
  const [closedSpreads, setClosedSpreads] = useState<CreditSpreadPosition[]>([]);
  const [activeSection, setActiveSection] = useState<'positions' | 'history' | 'watchlist' | 'log' | 'sniper' | 'spreads' | 'scalps' | 'playbook'>('positions');
  const [openScalps, setOpenScalps]   = useState<ScalpTrade[]>([]);
  const [closedScalps, setClosedScalps] = useState<ScalpTrade[]>([]);
  const [tierFilter, setTierFilter]     = useState<'ALL' | 'STABLE' | 'GROWTH' | 'HIGH_VOL'>('ALL');
  const [sectorFilter, setSectorFilter] = useState<string>('ALL');
  const [newOnly, setNewOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [openPos, closedPos, wl, monthStats, log, openSpr, closedSpr, openSc, closedSc] = await Promise.all([
        getOpenOptionsPositions(),
        getClosedOptionsPositions(20),
        getOptionsWatchlist(),
        getOptionsMonthlyStats(),
        getOptionsActivityLog(50),
        getOpenCreditSpreads(),
        getClosedCreditSpreads(20),
        getOpenScalpTrades(),
        getClosedScalpTrades(40),
      ]);
      setOpenPositions(openPos);
      setClosedPositions(closedPos);
      setWatchlist(wl);
      setStats(monthStats);
      setActivityLog(log);
      setOpenSpreads(openSpr);
      setClosedSpreads(closedSpr);
      setOpenScalps(openSc);
      setClosedScalps(closedSc);
    } catch (err) {
      console.error('Options tab load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Trigger a live options scan on the auto-trader, then poll for results.
  // The backend responds immediately (fire-and-forget); scan takes ~90s for full watchlist.
  const handleRefresh = useCallback(async () => {
    setScanning(true);
    console.log('[Options Scan] Requesting scan from auto-trader...');
    try {
      const res = await fetch('http://localhost:3001/api/scheduler/options-scan', {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
      const body = await res.json().catch(() => ({}));
      console.log('[Options Scan] Scan started:', body);
    } catch (err) {
      console.warn('[Options Scan] Auto-trader offline — refreshing data only.', err);
      setScanning(false);
      await load();
      return;
    }

    // Poll every 15s for up to 3 minutes, reloading data as results come in
    let elapsed = 0;
    const poll = setInterval(async () => {
      elapsed += 15;
      console.log(`[Options Scan] Polling for results... (${elapsed}s elapsed)`);
      await load();
      if (elapsed >= 180) {
        clearInterval(poll);
        setScanning(false);
        console.log('[Options Scan] Scan polling complete.');
      }
    }, 15_000);

    // Also do an immediate reload after 20s (first results arrive)
    setTimeout(async () => {
      console.log('[Options Scan] First-results reload (20s)');
      await load();
    }, 20_000);

    // Stop scanning indicator after 3 min regardless
    setTimeout(() => {
      clearInterval(poll);
      setScanning(false);
    }, 180_000);
  }, [load]);

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

  /**
   * Manually submit a paper-only options position to IB.
   * Calls the auto-trader's /api/options/place-order endpoint with the
   * position's contract details. On success the ib_order_id is written to
   * paper_trades by the auto-trader, so we reload to pick up the badge update.
   */
  async function handleSubmitToIB(positionId: string): Promise<void> {
    // The auto-trader route fetches contract details from paper_trades — just pass the ID.
    const res = await fetch('http://localhost:3001/api/options/place-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(140_000), // 2 min 20s — generous for IB round-trip
      body: JSON.stringify({ tradeId: positionId }),
    });

    const body = await res.json().catch(() => ({})) as { error?: string; orderId?: number; avgFillPrice?: number };
    if (!res.ok) {
      throw new Error(body.error ?? `IB rejected the order (HTTP ${res.status})`);
    }

    // Reload so the ✓ IB badge appears
    await load();
  }

  async function handleDiscardPaperTrade(positionId: string): Promise<void> {
    const res = await fetch('http://localhost:3001/api/options/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeId: positionId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Discard failed (HTTP ${res.status})`);
    }
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

  // Strike Sniper state
  const [sniperTicker, setSniperTicker] = useState('');
  const [sniperTarget, setSniperTarget] = useState('');
  const [sniperLoading, setSniperLoading] = useState(false);
  const [sniperResults, setSniperResults] = useState<{
    symbol: string;
    currentPrice: number | null;
    targetStrike: number;
    fundamental: { grade: string; score: number };
    contracts: Array<{
      expiry: string;
      strike: number;
      premium: number;
      delta: number;
      annualizedROI: number;
      dte: number;
      collateral: number;
    }>;
  } | null>(null);
  const [sniperError, setSniperError] = useState<string | null>(null);

  async function handleSniperSearch() {
    const ticker = sniperTicker.trim().toUpperCase();
    const target = parseFloat(sniperTarget);
    if (!ticker || !Number.isFinite(target) || target <= 0) return;
    setSniperLoading(true);
    setSniperError(null);
    setSniperResults(null);
    try {
      const res = await fetch(`http://localhost:3001/api/options/strike-sniper?symbol=${ticker}&targetStrike=${target}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Request failed');
      const data = await res.json();
      if (!data.contracts || data.contracts.length === 0) {
        setSniperError(`No contracts found near $${target} for ${ticker} (current price: $${data.currentPrice?.toFixed(0) ?? '?'}). Try a strike closer to the current price.`);
      } else {
        setSniperResults(data);
      }
    } catch (err) {
      setSniperError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setSniperLoading(false);
    }
  }

  const sections = [
    { id: 'positions' as const, label: 'Open', count: openPositions.length },
    { id: 'spreads' as const, label: 'Spreads', count: openSpreads.length },
    { id: 'scalps' as const, label: '⚡ Scalps', count: openScalps.length + closedScalps.length },
    { id: 'history' as const, label: 'History', count: closedPositions.length },
    { id: 'watchlist' as const, label: 'Watchlist', count: watchlist.filter(w => w.active).length },
    { id: 'sniper' as const, label: 'Sniper', count: 0 },
    { id: 'log' as const, label: 'Log', count: activityLog.length },
    { id: 'playbook' as const, label: '📖 Playbook', count: 0 },
  ];

  return (
    <div className="space-y-4">
      {/* Refresh / Trigger Scan */}
      <div className="flex items-center justify-end gap-2">
        {scanning && (
          <span className="text-[10px] text-amber-600 font-medium animate-pulse">Scanning…</span>
        )}
        <button
          onClick={handleRefresh}
          disabled={loading || scanning}
          title="Run options scan now"
          className="p-1.5 rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
        >
          <RefreshCw className={cn('w-4 h-4 text-[hsl(var(--muted-foreground))]', (loading || scanning) && 'animate-spin')} />
        </button>
      </div>

      {/* How it works — compact strip, always visible */}
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
                      onSubmitToIB={handleSubmitToIB}
                      onDiscard={handleDiscardPaperTrade}
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
                      onSubmitToIB={handleSubmitToIB}
                      onDiscard={handleDiscardPaperTrade}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Credit Spreads */}
      {activeSection === 'spreads' && (
        <div className="space-y-4">
          {/* Open spreads */}
          {openSpreads.length === 0 && closedSpreads.length === 0 ? (
            <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">
              No credit spread positions yet. Scans run Tue/Thu 10:30 AM ET.
            </div>
          ) : (
            <>
              {openSpreads.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-bold text-emerald-700">Open Spreads</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold">
                      {openSpreads.length}
                    </span>
                  </div>
                  {openSpreads.map(sp => (
                    <SpreadCard key={sp.id} spread={sp} />
                  ))}
                </div>
              )}
              {closedSpreads.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-bold text-[hsl(var(--muted-foreground))]">Closed Spreads</span>
                  </div>
                  {closedSpreads.map(sp => (
                    <SpreadCard key={sp.id} spread={sp} closed />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Scalps */}
      {activeSection === 'scalps' && (
        <div className="space-y-4">
          {openScalps.length === 0 && closedScalps.length === 0 ? (
            <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">
              No scalp trades yet. Scans run at 10:00 AM and 11:00 AM ET.
            </div>
          ) : (
            <>
              {/* Summary strip */}
              {closedScalps.length > 0 && (() => {
                const wins  = closedScalps.filter(s => (s.pnl ?? 0) > 0);
                const totalPnl = closedScalps.reduce((sum, s) => sum + (s.pnl ?? 0), 0);
                return (
                  <div className="flex items-center gap-3 rounded-lg bg-sky-50 border border-sky-100 px-3 py-2">
                    <span className="text-[10px] font-semibold text-sky-700">⚡ Scalp History</span>
                    <span className={cn('text-[11px] font-bold', totalPnl >= 0 ? 'text-emerald-700' : 'text-red-600')}>
                      {fmtUsd(totalPnl, 0, true)}
                    </span>
                    <span className="text-[10px] text-sky-500">
                      {wins.length}W / {closedScalps.length - wins.length}L
                    </span>
                  </div>
                );
              })()}

              {/* Open scalps */}
              {openScalps.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-bold text-sky-700">Live Positions</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 font-bold animate-pulse">
                      {openScalps.length}
                    </span>
                  </div>
                  {openScalps.map(s => <ScalpCard key={s.id} scalp={s} />)}
                </div>
              )}

              {/* Closed scalps */}
              {closedScalps.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-bold text-[hsl(var(--muted-foreground))]">Recent Closed</span>
                  </div>
                  {closedScalps.map(s => <ScalpCard key={s.id} scalp={s} closed />)}
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

          {/* ── Filters ────────────────────────────────── */}
          {(() => {
            const active = watchlist.filter(w => w.active);
            const sectors = ['ALL', ...Array.from(new Set(active.map(w => w.sector).filter(Boolean) as string[])).sort()];

            const isNew = (w: WatchlistTicker) =>
              w.created_at ? Date.now() - new Date(w.created_at).getTime() < 7 * 24 * 60 * 60 * 1000 : false;
            const newCount = active.filter(isNew).length;

            const filtered = active.filter(w => {
              if (tierFilter !== 'ALL' && w.tier !== tierFilter) return false;
              if (sectorFilter !== 'ALL' && w.sector !== sectorFilter) return false;
              if (newOnly && !isNew(w)) return false;
              return true;
            });

            function Pill({ label, active: isActive, onClick }: { label: string; active: boolean; onClick: () => void }) {
              return (
                <button
                  onClick={onClick}
                  className={cn(
                    'text-[10px] font-semibold px-2 py-1 rounded-full border transition-colors whitespace-nowrap',
                    isActive
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-violet-400 hover:text-violet-600'
                  )}
                >
                  {label}
                </button>
              );
            }

            return (
              <>
                <div className="space-y-1.5">
                  {/* Type filter */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium w-10 shrink-0">Type</span>
                    {(['ALL', 'STABLE', 'GROWTH', 'HIGH_VOL'] as const).map(t => (
                      <Pill key={t} label={t === 'ALL' ? 'All' : t === 'HIGH_VOL' ? 'High Vol' : t === 'STABLE' ? 'Stable' : 'Growth'} active={tierFilter === t} onClick={() => setTierFilter(t)} />
                    ))}
                  </div>
                  {/* Sector filter */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium w-10 shrink-0">Sector</span>
                    {sectors.map(s => (
                      <Pill key={s} label={s === 'ALL' ? 'All' : s} active={sectorFilter === s} onClick={() => setSectorFilter(s)} />
                    ))}
                  </div>
                  {/* New filter */}
                  {newCount > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium w-10 shrink-0"></span>
                      <button
                        onClick={() => setNewOnly(v => !v)}
                        className={cn(
                          'text-[10px] font-semibold px-2 py-1 rounded-full border transition-colors whitespace-nowrap flex items-center gap-1',
                          newOnly
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-emerald-400 hover:text-emerald-600'
                        )}
                      >
                        ✦ New this week
                        <span className={cn(
                          'text-[9px] px-1 py-0.5 rounded-full font-bold',
                          newOnly ? 'bg-emerald-700 text-emerald-100' : 'bg-emerald-100 text-emerald-700'
                        )}>
                          {newCount}
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Count */}
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                  Showing {filtered.length} of {active.length} tickers
                </p>

                {/* Watchlist items */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {filtered.map(w => {
                    const quote = prices.get(w.ticker);
                    const isNewThisWeek = isNew(w);
                    return (
                      <div key={w.id} className="flex flex-col rounded-xl border px-3 py-2 gap-1 border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                        <div className="flex items-start justify-between gap-1">
                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                              <p className="text-sm font-bold text-[hsl(var(--foreground))]">{w.ticker}</p>
                              <span className={cn(
                                'text-[9px] font-semibold px-1 py-0.5 rounded uppercase tracking-wide',
                                w.tier === 'STABLE'   && 'bg-emerald-100 text-emerald-700',
                                w.tier === 'GROWTH'   && 'bg-blue-100 text-blue-700',
                                w.tier === 'HIGH_VOL' && 'bg-amber-100 text-amber-700',
                                !w.tier               && 'bg-gray-100 text-gray-500',
                              )}>
                                {w.tier === 'STABLE' ? 'Stable' : w.tier === 'HIGH_VOL' ? 'High Vol' : 'Growth'}
                              </span>
                              {isNewThisWeek && (
                                <span className="text-[9px] font-semibold px-1 py-0.5 rounded tracking-wide bg-emerald-100 text-emerald-700">
                                  ✦ New
                                </span>
                              )}
                            </div>
                            {w.sector && (
                              <span className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">{w.sector}</span>
                            )}
                            {quote ? (
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
                            ) : (
                              <span className="text-[10px] text-[hsl(var(--muted-foreground))]/40 tabular-nums">—</span>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              title="Edit description"
                              onClick={() => { setEditingNotes(w.ticker); setEditNotesValue(w.notes ?? ''); }}
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
              </>
            );
          })()}

        </div>
      )}

      {/* Strike Sniper */}
      {activeSection === 'sniper' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-violet-700" />
              <span className="text-xs font-semibold text-violet-800">Strike Sniper</span>
            </div>
            <p className="text-[10px] text-violet-700 leading-relaxed">
              Enter a stock and your target ownership price. The sniper finds the best put contract across all expirations, ranked by annualized return.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Ticker"
                value={sniperTicker}
                onChange={e => setSniperTicker(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleSniperSearch()}
                className="w-24 text-sm px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
              <input
                type="number"
                placeholder="Target price"
                value={sniperTarget}
                onChange={e => setSniperTarget(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSniperSearch()}
                className="w-32 text-sm px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
              <button
                onClick={handleSniperSearch}
                disabled={sniperLoading || !sniperTicker.trim() || !sniperTarget}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                {sniperLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Find
              </button>
            </div>
          </div>

          {sniperError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-xs text-red-700">{sniperError}</p>
            </div>
          )}

          {sniperResults && (
            <div className="space-y-3">
              <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[hsl(var(--foreground))]">{sniperResults.symbol}</span>
                    {sniperResults.currentPrice != null && (
                      <span className="text-xs text-[hsl(var(--muted-foreground))]">
                        Current: <span className="font-semibold">${sniperResults.currentPrice.toFixed(2)}</span>
                      </span>
                    )}
                    <span className="text-xs text-[hsl(var(--muted-foreground))]">
                      Target: <span className="font-semibold text-violet-700">${sniperResults.targetStrike}</span>
                    </span>
                  </div>
                  <span className={cn(
                    'text-[10px] px-2 py-0.5 rounded-full font-bold',
                    sniperResults.fundamental.grade === 'A' && 'bg-emerald-100 text-emerald-700',
                    sniperResults.fundamental.grade === 'B' && 'bg-blue-100 text-blue-700',
                    sniperResults.fundamental.grade === 'C' && 'bg-amber-100 text-amber-700',
                    (sniperResults.fundamental.grade === 'D' || sniperResults.fundamental.grade === 'F') && 'bg-red-100 text-red-700',
                  )}>
                    Grade: {sniperResults.fundamental.grade} ({sniperResults.fundamental.score})
                  </span>
                </div>
              </div>

              {sniperResults.contracts.length === 0 ? (
                <div className="text-center py-8 text-sm text-[hsl(var(--muted-foreground))]">
                  No contracts found meeting the minimum return threshold. Try a different target price.
                </div>
              ) : (
                <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-[hsl(var(--muted))]/50 text-[hsl(var(--muted-foreground))]">
                        <th className="text-left px-3 py-2 font-semibold">Expiry</th>
                        <th className="text-right px-3 py-2 font-semibold">DTE</th>
                        <th className="text-right px-3 py-2 font-semibold">Strike</th>
                        <th className="text-right px-3 py-2 font-semibold">Premium</th>
                        <th className="text-right px-3 py-2 font-semibold">Delta</th>
                        <th className="text-right px-3 py-2 font-semibold">Ann. ROI</th>
                        <th className="text-right px-3 py-2 font-semibold">Collateral</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sniperResults.contracts.map((c, i) => {
                        const expiryFmt = c.expiry.length === 8
                          ? `${c.expiry.slice(0, 4)}-${c.expiry.slice(4, 6)}-${c.expiry.slice(6, 8)}`
                          : c.expiry;
                        return (
                          <tr
                            key={i}
                            className={cn(
                              'border-t border-[hsl(var(--border))]',
                              i === 0 && 'bg-emerald-50/60',
                            )}
                          >
                            <td className="px-3 py-2 font-medium text-[hsl(var(--foreground))]">
                              {new Date(expiryFmt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              {i === 0 && <span className="ml-1.5 text-[9px] font-bold text-emerald-700 bg-emerald-100 px-1 py-0.5 rounded">BEST</span>}
                            </td>
                            <td className="text-right px-3 py-2 tabular-nums">{c.dte}d</td>
                            <td className="text-right px-3 py-2 font-semibold tabular-nums">${c.strike}</td>
                            <td className="text-right px-3 py-2 text-emerald-700 font-semibold tabular-nums">${c.premium.toFixed(2)}</td>
                            <td className="text-right px-3 py-2 tabular-nums">{Math.abs(c.delta).toFixed(2)}</td>
                            <td className={cn(
                              'text-right px-3 py-2 font-bold tabular-nums',
                              c.annualizedROI >= 20 ? 'text-emerald-700' : c.annualizedROI >= 10 ? 'text-blue-700' : 'text-[hsl(var(--foreground))]'
                            )}>
                              {c.annualizedROI.toFixed(1)}%
                            </td>
                            <td className="text-right px-3 py-2 tabular-nums text-[hsl(var(--muted-foreground))]">{fmtUsd(c.collateral, 0)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Playbook — all strategy guides in one tabbed panel */}
      {activeSection === 'playbook' && <OptionsPlaybook />}

    </div>
  );
}
