import { AlertTriangle } from 'lucide-react';
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
  return (
    <div>
      <label className="block text-xs font-medium text-[hsl(var(--foreground))] mb-1">
        {label}
      </label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
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

export function SettingsTab({ config, onUpdate }: SettingsTabProps) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-6 space-y-6">
      <h3 className="text-lg font-semibold text-[hsl(var(--foreground))]">Auto-Trading Settings</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Position Size (per trade)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
            <input
              type="number"
              value={config.positionSize}
              onChange={e => onUpdate({ positionSize: Number(e.target.value) })}
              className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
              min={100}
              step={100}
            />
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Paper money allocated per trade</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Max Concurrent Positions
          </label>
          <input
            type="number"
            value={config.maxPositions}
            onChange={e => onUpdate({ maxPositions: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Max open positions at once</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Min Scanner Confidence
          </label>
          <input
            type="number"
            value={config.minScannerConfidence}
            onChange={e => onUpdate({ minScannerConfidence: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Scanner confidence threshold (1-10)</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Min Full Analysis Confidence
          </label>
          <input
            type="number"
            value={config.minFAConfidence}
            onChange={e => onUpdate({ minFAConfidence: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Both scanner AND FA must meet threshold</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Suggested Finds Min Conviction
          </label>
          <input
            type="number"
            value={config.minSuggestedFindsConviction}
            onChange={e => onUpdate({ minSuggestedFindsConviction: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Only Undervalued/Deep Value stocks at this conviction or higher</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            IB Account ID
          </label>
          <input
            type="text"
            value={config.accountId ?? ''}
            onChange={e => onUpdate({ accountId: e.target.value || null })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm font-mono"
            placeholder="Auto-detected from gateway"
          />
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
              Max Total Allocation
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
              <input
                type="number"
                value={config.maxTotalAllocation}
                onChange={e => onUpdate({ maxTotalAllocation: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
                min={10000}
                step={10000}
              />
            </div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Hard cap on total deployed capital</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
              Daily Deployment Limit
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
              <input
                type="number"
                value={config.maxDailyDeployment}
                onChange={e => onUpdate({ maxDailyDeployment: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
                min={5000}
                step={5000}
              />
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
              onChange={v => onUpdate({ baseAllocationPct: v })} min={0.5} max={10} step={0.5}
              help="% of portfolio per long-term position" />
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
                <input type="number" value={config[tier.dipKey]}
                  onChange={e => onUpdate({ [tier.dipKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={1} max={50} step={1} />
                <input type="number" value={config[tier.sizeKey]}
                  onChange={e => onUpdate({ [tier.sizeKey]: Number(e.target.value) })}
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
                <input type="number" value={config[tier.gainKey]}
                  onChange={e => onUpdate({ [tier.gainKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={5} max={200} step={5} />
                <input type="number" value={config[tier.trimKey]}
                  onChange={e => onUpdate({ [tier.trimKey]: Number(e.target.value) })}
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
                <input type="number" value={config[tier.lossKey]}
                  onChange={e => onUpdate({ [tier.lossKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={3} max={50} step={1} />
                <input type="number" value={config[tier.sellKey]}
                  onChange={e => onUpdate({ [tier.sellKey]: Number(e.target.value) })}
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
              <input type="number" value={config.earningsBlackoutDays}
                onChange={e => onUpdate({ earningsBlackoutDays: Number(e.target.value) })}
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
