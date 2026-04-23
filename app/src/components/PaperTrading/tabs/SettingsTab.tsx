import { AlertTriangle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { cn } from '../../../lib/utils';
import type { AutoTraderConfig } from '../../../lib/autoTrader';

function SettingsToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0',
        enabled ? 'bg-emerald-600' : 'bg-slate-300'
      )}
    >
      <span className={cn(
        'inline-block h-4 w-4 rounded-full bg-white transition-transform',
        enabled ? 'translate-x-6' : 'translate-x-1'
      )} />
    </button>
  );
}

function SettingsInput({ label, value, onChange, min, max, step, help }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);

  return (
    <div>
      <label className="block text-xs font-medium text-[hsl(var(--foreground))] mb-1">
        {label}
      </label>
      <input
        type="number"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (!isNaN(n) && n !== value) onChange(n);
        }}
        className="w-full px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs"
        min={min}
        max={max}
        step={step}
      />
      {help && <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">{help}</p>}
    </div>
  );
}

export interface SettingsTabProps {
  config: AutoTraderConfig;
  onUpdate: (updates: Partial<AutoTraderConfig>) => void;
}

// Thin wrapper so inline number inputs don't save on every keystroke.
// Keeps local string state; commits to DB only on blur.
function NumInput({
  value,
  onCommit,
  className,
  min,
  max,
  step,
}: {
  value: number;
  onCommit: (v: number) => void;
  className?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);
  return (
    <input
      type="number"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => {
        const n = Number(local);
        if (!isNaN(n) && n !== value) onCommit(n);
      }}
      className={className}
      min={min}
      max={max}
      step={step}
    />
  );
}

function TextInput({ value, onCommit, className, placeholder }: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <input
      type="text"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
      className={className}
      placeholder={placeholder}
    />
  );
}

export function SettingsTab({ config, onUpdate }: SettingsTabProps) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-6 space-y-6">
      <h3 className="text-lg font-semibold text-[hsl(var(--foreground))]">Auto-Trading Settings</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Flat Position Size (dynamic sizing off)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
            <NumInput value={config.positionSize} onCommit={v => onUpdate({ positionSize: v })}
              className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
              min={100} step={100} />
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Fixed $ per trade — only used when dynamic sizing is disabled</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Max Concurrent Positions
          </label>
          <NumInput value={config.maxPositions} onCommit={v => onUpdate({ maxPositions: v })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1} max={10} />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Max open positions at once</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Min Scanner Confidence
          </label>
          <NumInput value={config.minScannerConfidence} onCommit={v => onUpdate({ minScannerConfidence: v })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1} max={10} />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Scanner confidence threshold (1-10)</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Min Full Analysis Confidence
          </label>
          <NumInput value={config.minFAConfidence} onCommit={v => onUpdate({ minFAConfidence: v })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1} max={10} />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Fallback only — used when scanner lacks entry/stop/target</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Suggested Finds Min Conviction
          </label>
          <NumInput value={config.minSuggestedFindsConviction} onCommit={v => onUpdate({ minSuggestedFindsConviction: v })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1} max={10} />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Only Undervalued/Deep Value stocks at this conviction or higher</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            IB Account ID
          </label>
          <TextInput value={config.accountId ?? ''} onCommit={v => onUpdate({ accountId: v || null })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm font-mono"
            placeholder="Auto-detected from gateway" />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Paper account ID (auto-detected on connect)</p>
        </div>

        <div className="flex items-center gap-3 pt-6">
          <button
            onClick={() => onUpdate({ dayTradeAutoClose: !config.dayTradeAutoClose })}
            className={cn(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              config.dayTradeAutoClose ? 'bg-emerald-600' : 'bg-slate-300'
            )}
          >
            <span className={cn(
              'inline-block h-4 w-4 rounded-full bg-white transition-transform',
              config.dayTradeAutoClose ? 'translate-x-6' : 'translate-x-1'
            )} />
          </button>
          <div>
            <p className="text-sm font-medium text-[hsl(var(--foreground))]">Day Trade Auto-Close</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Close all day trades at 3:55 PM ET</p>
          </div>
        </div>
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-4">Testing Budget</h4>
        <div className="mb-5 p-4 rounded-lg bg-slate-50 border border-[hsl(var(--border))]">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-[hsl(var(--foreground))]">Allocation Split</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Long-term: {config.longTermBucketPct}% &nbsp;·&nbsp; Day/Swing: {100 - config.longTermBucketPct}%
            </p>
          </div>
          <input
            type="range"
            min={10} max={80} step={5}
            value={config.longTermBucketPct}
            onChange={e => onUpdate({ longTermBucketPct: Number(e.target.value) })}
            className="w-full accent-emerald-600"
          />
          <div className="flex justify-between text-[10px] text-[hsl(var(--muted-foreground))] mt-1">
            <span>10% long-term</span>
            <span>80% long-term</span>
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
            Suggested Finds + dip buys use the long-term bucket. Scanner + influencer strategies use the rest.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
              Max Total Allocation
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
              <NumInput value={config.maxTotalAllocation} onCommit={v => onUpdate({ maxTotalAllocation: v })}
                className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
                min={10000} step={10000} />
            </div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Hard cap on total deployed capital</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
              Daily Deployment Limit
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
              <NumInput value={config.maxDailyDeployment} onCommit={v => onUpdate({ maxDailyDeployment: v })}
                className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
                min={5000} step={5000} />
            </div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Max new capital per day (prevents budget blowouts)</p>
          </div>
        </div>
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.useDynamicSizing}
            onToggle={() => onUpdate({ useDynamicSizing: !config.useDynamicSizing })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Dynamic Position Sizing</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Conviction-weighted + risk-based sizing (replaces flat $ per trade)</p>
          </div>
        </div>
        {config.useDynamicSizing && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pl-14">
            <SettingsInput label="Base Allocation %" value={config.baseAllocationPct}
              onChange={v => onUpdate({ baseAllocationPct: v })} min={0.5} max={20} step={0.5}
              help="% of max allocation per trade (day/swing/long-term)" />
            <SettingsInput label="Max Position %" value={config.maxPositionPct}
              onChange={v => onUpdate({ maxPositionPct: v })} min={1} max={20} step={1}
              help="Max single-position % of portfolio" />
            <SettingsInput label="Risk Per Trade %" value={config.riskPerTradePct}
              onChange={v => onUpdate({ riskPerTradePct: v })} min={0.25} max={5} step={0.25}
              help="Max risk % per scanner trade" />
          </div>
        )}
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.dipBuyEnabled}
            onToggle={() => onUpdate({ dipBuyEnabled: !config.dipBuyEnabled })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Dip Buying</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto average-down when long-term positions drop</p>
          </div>
        </div>
        {config.dipBuyEnabled && (
          <div className="space-y-3 pl-14">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Tier</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Dip %</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Add-on Size %</div>
            </div>
            {[
              { label: 'Tier 1', dipKey: 'dipBuyTier1Pct' as const, sizeKey: 'dipBuyTier1SizePct' as const },
              { label: 'Tier 2', dipKey: 'dipBuyTier2Pct' as const, sizeKey: 'dipBuyTier2SizePct' as const },
              { label: 'Tier 3', dipKey: 'dipBuyTier3Pct' as const, sizeKey: 'dipBuyTier3SizePct' as const },
            ].map(tier => (
              <div key={tier.label} className="grid grid-cols-3 gap-3 items-center">
                <span className="text-xs font-medium">{tier.label}</span>
                <NumInput value={config[tier.dipKey]} onCommit={v => onUpdate({ [tier.dipKey]: v })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={1} max={50} step={1} />
                <NumInput value={config[tier.sizeKey]} onCommit={v => onUpdate({ [tier.sizeKey]: v })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={10} max={200} step={10} />
              </div>
            ))}
            <SettingsInput label="Cooldown (hours)" value={config.dipBuyCooldownHours}
              onChange={v => onUpdate({ dipBuyCooldownHours: v })} min={1} max={168} step={1}
              help="Min hours between dip buys for same ticker" />
          </div>
        )}
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.profitTakeEnabled}
            onToggle={() => onUpdate({ profitTakeEnabled: !config.profitTakeEnabled })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Profit Taking</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto trim long-term positions on rallies</p>
          </div>
        </div>
        {config.profitTakeEnabled && (
          <div className="space-y-3 pl-14">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Tier</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Gain %</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Trim %</div>
            </div>
            {[
              { label: 'Tier 1', gainKey: 'profitTakeTier1Pct' as const, trimKey: 'profitTakeTier1TrimPct' as const },
              { label: 'Tier 2', gainKey: 'profitTakeTier2Pct' as const, trimKey: 'profitTakeTier2TrimPct' as const },
              { label: 'Tier 3', gainKey: 'profitTakeTier3Pct' as const, trimKey: 'profitTakeTier3TrimPct' as const },
            ].map(tier => (
              <div key={tier.label} className="grid grid-cols-3 gap-3 items-center">
                <span className="text-xs font-medium">{tier.label}</span>
                <NumInput value={config[tier.gainKey]} onCommit={v => onUpdate({ [tier.gainKey]: v })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={5} max={200} step={5} />
                <NumInput value={config[tier.trimKey]} onCommit={v => onUpdate({ [tier.trimKey]: v })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={5} max={50} step={5} />
              </div>
            ))}
            <SettingsInput label="Min Hold %" value={config.minHoldPct}
              onChange={v => onUpdate({ minHoldPct: v })} min={10} max={80} step={5}
              help="Never sell below this % of original position" />
          </div>
        )}
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.lossCutEnabled}
            onToggle={() => onUpdate({ lossCutEnabled: !config.lossCutEnabled })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Loss Cutting</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto-sell losers to protect capital</p>
          </div>
        </div>
        {config.lossCutEnabled && (
          <div className="space-y-3 pl-14">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Tier</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Loss %</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Sell %</div>
            </div>
            {[
              { label: 'Tier 1', lossKey: 'lossCutTier1Pct' as const, sellKey: 'lossCutTier1SellPct' as const },
              { label: 'Tier 2', lossKey: 'lossCutTier2Pct' as const, sellKey: 'lossCutTier2SellPct' as const },
              { label: 'Tier 3 (exit)', lossKey: 'lossCutTier3Pct' as const, sellKey: 'lossCutTier3SellPct' as const },
            ].map(tier => (
              <div key={tier.label} className="grid grid-cols-3 gap-3 items-center">
                <span className="text-xs font-medium">{tier.label}</span>
                <NumInput value={config[tier.lossKey]} onCommit={v => onUpdate({ [tier.lossKey]: v })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={3} max={50} step={1} />
                <NumInput value={config[tier.sellKey]} onCommit={v => onUpdate({ [tier.sellKey]: v })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={10} max={100} step={5} />
              </div>
            ))}
            <SettingsInput label="Min Hold Days" value={config.lossCutMinHoldDays}
              onChange={v => onUpdate({ lossCutMinHoldDays: v })} min={0} max={14} step={1}
              help="Must hold at least this many days before cutting (avoids intraday noise)" />
          </div>
        )}
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-4">Risk Management</h4>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <SettingsToggle enabled={config.marketRegimeEnabled}
              onToggle={() => onUpdate({ marketRegimeEnabled: !config.marketRegimeEnabled })} />
            <div>
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Market Regime Awareness</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Reduce sizing when VIX is high / SPY trending down</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <SettingsToggle enabled={config.earningsAvoidEnabled}
              onToggle={() => onUpdate({ earningsAvoidEnabled: !config.earningsAvoidEnabled })} />
            <div className="flex-1">
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Earnings Blackout</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Skip new entries near earnings announcements</p>
            </div>
            {config.earningsAvoidEnabled && (
              <NumInput value={config.earningsBlackoutDays} onCommit={v => onUpdate({ earningsBlackoutDays: v })}
                className="w-16 px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs text-right"
                min={1} max={14} />
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingsInput label="Max Sector %" value={config.maxSectorPct}
              onChange={v => onUpdate({ maxSectorPct: v })} min={10} max={100} step={5}
              help="Max portfolio allocation to one sector" />
          </div>

          <div className="flex items-center gap-3">
            <SettingsToggle enabled={config.kellyAdaptiveEnabled}
              onToggle={() => onUpdate({ kellyAdaptiveEnabled: !config.kellyAdaptiveEnabled })} />
            <div>
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Adaptive Sizing (Half-Kelly)</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto-adjust sizing based on actual win rate (needs 10+ completed trades)</p>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-4">Suggested Finds</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
              Position Size per Find
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
              <NumInput
                value={config.suggestedFindPositionSize}
                onCommit={v => onUpdate({ suggestedFindPositionSize: v })}
                className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
                min={0} step={500}
              />
            </div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Flat $ per Suggested Find buy (0 = use dynamic sizing)</p>
          </div>
        </div>
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-4">Capital Recycling</h4>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
          Automatically frees up capital when the allocation cap is reached, so new high-conviction signals aren't blocked.
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingsInput
              label="Swing Max Hold Days"
              value={config.swingMaxHoldDays}
              onChange={v => onUpdate({ swingMaxHoldDays: v })}
              min={0} max={30} step={1}
              help="Auto-close swing trades held longer than this (0 = off). Frees capital for fresh signals."
            />
          </div>
          <div className="flex items-center gap-3">
            <SettingsToggle
              enabled={config.capitalPressureEnabled}
              onToggle={() => onUpdate({ capitalPressureEnabled: !config.capitalPressureEnabled })}
            />
            <div>
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Capital-Pressure Redeployment</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                When at cap, auto-close the most-profitable open swing trade to make room for a new signal
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Long-term auto-sell */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-3">Suggested Finds — Auto-Sell Rules</h3>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-3">
          Long-term positions are automatically closed when they hit these thresholds, freeing capital for new opportunities.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SettingsInput
            label="Stop-Loss %"
            value={config.ltStopLossPct}
            onChange={v => onUpdate({ ltStopLossPct: v })}
            min={-50} max={0} step={1}
            help="Close if down more than this % (e.g. -10). Closes LMT & RTX immediately at -10."
          />
          <SettingsInput
            label="Profit-Take %"
            value={config.ltProfitTakePct}
            onChange={v => onUpdate({ ltProfitTakePct: v })}
            min={0} max={100} step={1}
            help="Close if up more than this % (e.g. 15 = +15% gain)"
          />
          <SettingsInput
            label="Max Hold Days"
            value={config.ltMaxHoldDays}
            onChange={v => onUpdate({ ltMaxHoldDays: v })}
            min={0} max={365} step={1}
            help="Force-close after this many days (0 = disabled)"
          />
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200/70 px-4 py-3 mt-4">
        <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-800">Paper Trading — Signal Quality Test</p>
          <p className="text-xs text-amber-700 mt-0.5">
            Testing AI signal quality with ${config.maxTotalAllocation.toLocaleString()} budget over 1 month.
            Orders are placed on your IB paper account with simulated money.
          </p>
        </div>
      </div>
    </div>
  );
}
