import {
  DollarSign,
  Activity,
  TrendingUp,
  TrendingDown,
  Brain,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Gauge,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { AutoTraderConfig } from '../../../lib/autoTrader';
import type { MarketRegime } from '../../../lib/autoTrader';
import type { AutoTradeEventRecord } from '../../../lib/paperTradesApi';
import type { IBPosition } from '../../../lib/ibClient';
import { fmtUsd } from '../utils';

export interface SmartTradingTabProps {
  config: AutoTraderConfig;
  regime: MarketRegime | null;
  kellyMultiplier: number;
  totalDeployed: number;
  events: AutoTradeEventRecord[];
  positions: IBPosition[];
}

function FeatureCard({ label, enabled, detail }: { label: string; enabled: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-white">
      <div className={cn(
        'w-2 h-2 rounded-full flex-shrink-0',
        enabled ? 'bg-emerald-500' : 'bg-slate-300'
      )} />
      <div className="min-w-0">
        <p className={cn('text-xs font-medium', enabled ? 'text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]')}>
          {label}
        </p>
        {detail && <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate">{detail}</p>}
        {!enabled && !detail && <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Off</p>}
      </div>
    </div>
  );
}

export function SmartTradingTab({ config, regime, kellyMultiplier, totalDeployed, events, positions }: SmartTradingTabProps) {
  const smartEvents = events.filter(e =>
    e.source === 'dip_buy' || e.source === 'profit_take' || e.source === 'loss_cut' ||
    (e.skip_reason && (
      e.skip_reason.toLowerCase().includes('sector') ||
      e.skip_reason.toLowerCase().includes('earnings') ||
      e.skip_reason.toLowerCase().includes('allocation') ||
      e.skip_reason.toLowerCase().includes('drawdown') ||
      e.skip_reason.toLowerCase().includes('daily') ||
      e.skip_reason.toLowerCase().includes('circuit')
    ))
  );

  const deployedPct = config.maxTotalAllocation > 0 ? (totalDeployed / config.maxTotalAllocation) * 100 : 0;

  const positionsWithDip = positions
    .filter(p => p.avgCost > 0 && p.mktPrice > 0)
    .map(p => ({
      ticker: p.contractDesc,
      shares: Math.abs(p.position),
      avgCost: p.avgCost,
      mktPrice: p.mktPrice,
      changePct: ((p.mktPrice - p.avgCost) / p.avgCost) * 100,
      unrealizedPnl: p.unrealizedPnl,
    }))
    .sort((a, b) => a.changePct - b.changePct);

  const regimeColors: Record<string, string> = {
    panic: 'text-red-600 bg-red-50 border-red-200',
    fear: 'text-amber-600 bg-amber-50 border-amber-200',
    normal: 'text-blue-600 bg-blue-50 border-blue-200',
    complacent: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    disabled: 'text-slate-500 bg-slate-50 border-slate-200',
  };

  const regimeIcons: Record<string, React.ReactNode> = {
    panic: <ShieldAlert className="w-4 h-4" />,
    fear: <Shield className="w-4 h-4" />,
    normal: <ShieldCheck className="w-4 h-4" />,
    complacent: <ShieldCheck className="w-4 h-4" />,
    disabled: <Shield className="w-4 h-4" />,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className={cn('rounded-xl border p-4', regimeColors[regime?.label ?? 'disabled'])}>
          <div className="flex items-center gap-2 mb-2">
            {regimeIcons[regime?.label ?? 'disabled']}
            <span className="text-xs font-medium opacity-75">Market Regime</span>
          </div>
          <p className="text-xl font-bold capitalize">{regime?.label ?? 'N/A'}</p>
          {regime?.vix != null && (
            <p className="text-[10px] mt-0.5 opacity-60">VIX: {regime.vix.toFixed(1)} &middot; {regime.multiplier.toFixed(2)}x sizing</p>
          )}
          {!config.marketRegimeEnabled && (
            <p className="text-[10px] mt-0.5 opacity-60">Disabled in settings</p>
          )}
        </div>

        <div className={cn('rounded-xl border p-4', config.kellyAdaptiveEnabled ? 'bg-violet-50 border-violet-200 text-violet-700' : 'bg-slate-50 border-slate-200 text-slate-500')}>
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Kelly Multiplier</span>
          </div>
          <p className="text-xl font-bold">{kellyMultiplier.toFixed(2)}x</p>
          <p className="text-[10px] mt-0.5 opacity-60">
            {config.kellyAdaptiveEnabled
              ? 'Half-Kelly adaptive sizing'
              : 'Disabled — using 1.0x'}
          </p>
        </div>

        <div className={cn('rounded-xl border p-4', deployedPct > 85 ? 'bg-red-50 border-red-200 text-red-700' : deployedPct > 60 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700')}>
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Allocation</span>
          </div>
          <p className="text-xl font-bold">{deployedPct.toFixed(0)}%</p>
          <p className="text-[10px] mt-0.5 opacity-60">
            {fmtUsd(totalDeployed, 0)} / {fmtUsd(config.maxTotalAllocation, 0)} cap
          </p>
        </div>

        {(() => {
          const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
          const totalCost = positions.reduce((s, p) => s + Math.abs(p.position) * p.avgCost, 0);
          const pnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
          const level = pnlPct <= -5 ? 'critical' : pnlPct <= -3 ? 'defensive' : pnlPct <= -1 ? 'caution' : 'normal';
          const levelColors: Record<string, string> = {
            normal: 'bg-emerald-50 border-emerald-200 text-emerald-700',
            caution: 'bg-amber-50 border-amber-200 text-amber-700',
            defensive: 'bg-orange-50 border-orange-200 text-orange-700',
            critical: 'bg-red-50 border-red-200 text-red-700',
          };
          const mult = level === 'critical' ? 0 : level === 'defensive' ? 0.5 : level === 'caution' ? 0.75 : 1.0;
          return (
            <div className={cn('rounded-xl border p-4', levelColors[level])}>
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-4 h-4" />
                <span className="text-xs font-medium opacity-75">Drawdown Guard</span>
              </div>
              <p className="text-xl font-bold capitalize">{level}</p>
              <p className="text-[10px] mt-0.5 opacity-60">
                P&L: {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}% &middot; Sizing: {(mult * 100).toFixed(0)}%
              </p>
            </div>
          );
        })()}
      </div>

      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Strategy Modules</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-[hsl(var(--border))]">
          <FeatureCard
            label="Dip Buying"
            enabled={config.dipBuyEnabled}
            detail={config.dipBuyEnabled
              ? `Tiers: -${config.dipBuyTier1Pct}% / -${config.dipBuyTier2Pct}% / -${config.dipBuyTier3Pct}%`
              : undefined}
          />
          <FeatureCard
            label="Profit Taking"
            enabled={config.profitTakeEnabled}
            detail={config.profitTakeEnabled
              ? `Tiers: +${config.profitTakeTier1Pct}% / +${config.profitTakeTier2Pct}% / +${config.profitTakeTier3Pct}%`
              : undefined}
          />
          <FeatureCard
            label="Loss Cutting"
            enabled={config.lossCutEnabled}
            detail={config.lossCutEnabled
              ? `Tiers: -${config.lossCutTier1Pct}% / -${config.lossCutTier2Pct}% / -${config.lossCutTier3Pct}%`
              : undefined}
          />
          <FeatureCard
            label="Market Regime"
            enabled={config.marketRegimeEnabled}
            detail={regime?.vix != null ? `VIX ${regime.vix.toFixed(1)} → ${regime.multiplier.toFixed(2)}x` : undefined}
          />
          <FeatureCard
            label="Sector Limits"
            enabled={config.maxSectorPct < 100}
            detail={`Max ${config.maxSectorPct}% per sector`}
          />
          <FeatureCard
            label="Earnings Blackout"
            enabled={config.earningsAvoidEnabled}
            detail={config.earningsAvoidEnabled ? `Skip ${config.earningsBlackoutDays}d before earnings` : undefined}
          />
          <FeatureCard
            label="Kelly Adaptive"
            enabled={config.kellyAdaptiveEnabled}
            detail={config.kellyAdaptiveEnabled ? `${kellyMultiplier.toFixed(2)}x multiplier` : undefined}
          />
        </div>
      </div>

      {positionsWithDip.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Position Triggers</h3>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
              How close each position is to dip buy (red) or profit take (green) thresholds
            </p>
          </div>
          <div className="divide-y divide-[hsl(var(--border))]">
            {positionsWithDip.map(p => {
              const isDip = p.changePct < 0;
              const absPct = Math.abs(p.changePct);
              const nearestDipTier = isDip
                ? (absPct >= config.dipBuyTier3Pct ? 3 : absPct >= config.dipBuyTier2Pct ? 2 : absPct >= config.dipBuyTier1Pct ? 1 : 0)
                : 0;
              const nearestProfitTier = !isDip
                ? (p.changePct >= config.profitTakeTier3Pct ? 3 : p.changePct >= config.profitTakeTier2Pct ? 2 : p.changePct >= config.profitTakeTier1Pct ? 1 : 0)
                : 0;

              return (
                <div key={p.ticker} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="font-bold text-sm w-14 text-[hsl(var(--foreground))]">{p.ticker}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-slate-100 relative overflow-hidden">
                        <div
                          className={cn(
                            'absolute top-0 h-full rounded-full transition-all',
                            isDip ? 'bg-red-400 right-1/2' : 'bg-emerald-400 left-1/2',
                          )}
                          style={{ width: `${Math.min(absPct * 2, 50)}%` }}
                        />
                        <div className="absolute top-0 left-1/2 w-px h-full bg-slate-300" />
                      </div>
                    </div>
                  </div>
                  <span className={cn(
                    'text-xs font-bold tabular-nums w-16 text-right',
                    isDip ? 'text-red-600' : 'text-emerald-600'
                  )}>
                    {p.changePct >= 0 ? '+' : ''}{p.changePct.toFixed(1)}%
                  </span>
                  {nearestDipTier > 0 && config.dipBuyEnabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                      Dip T{nearestDipTier}
                    </span>
                  )}
                  {nearestProfitTier > 0 && config.profitTakeEnabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                      Profit T{nearestProfitTier}
                    </span>
                  )}
                  {nearestDipTier === 0 && nearestProfitTier === 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium w-16 text-center">
                      No trigger
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {smartEvents.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Recent Smart Actions</h3>
          </div>
          <div className="divide-y divide-[hsl(var(--border))] max-h-64 overflow-y-auto">
            {smartEvents.slice(0, 20).map(event => (
              <div key={event.id} className="flex items-start gap-2 px-4 py-2 text-xs">
                {event.source === 'dip_buy' && <TrendingDown className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />}
                {event.source === 'profit_take' && <TrendingUp className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />}
                {event.source !== 'dip_buy' && event.source !== 'profit_take' && (
                  <Shield className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="font-bold text-[hsl(var(--foreground))]">{event.ticker}</span>
                  {event.action && (
                    <span className={cn('ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium', {
                      'bg-emerald-100 text-emerald-700': event.action === 'executed',
                      'bg-amber-100 text-amber-700': event.action === 'skipped',
                      'bg-red-100 text-red-700': event.action === 'failed',
                    })}>{event.source === 'dip_buy' ? 'dip buy' : event.source === 'profit_take' ? 'profit take' : 'blocked'}</span>
                  )}
                  <span className="text-[hsl(var(--muted-foreground))] ml-1.5">{event.message}</span>
                </div>
                <span className="text-[hsl(var(--muted-foreground))] flex-shrink-0 tabular-nums whitespace-nowrap">
                  {new Date(event.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {smartEvents.length === 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center">
          <Brain className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No smart trading actions yet</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
            Dip buys, profit takes, and risk blocks will appear here
          </p>
        </div>
      )}
    </div>
  );
}
