import { useState, useEffect } from 'react';
import { CircleDollarSign, Zap, ZapOff } from 'lucide-react';
import { OptionsTab } from './PaperTrading/tabs/OptionsTab';
import { getOptionsAutoTradeEnabled, setOptionsAutoTradeEnabled } from '../lib/optionsApi';
import { cn } from '../lib/utils';

/**
 * Top-level Options Wheel page — accessible via /options route.
 *
 * A standalone premium income engine for selling puts and covered calls
 * on quality stocks. Separate from Paper Trading — this is its own product.
 */
export function OptionsWheelPage() {
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    getOptionsAutoTradeEnabled().then(setAutoTradeEnabled).catch(() => {});
  }, []);

  async function handleToggle() {
    setToggling(true);
    try {
      const next = !autoTradeEnabled;
      await setOptionsAutoTradeEnabled(next);
      setAutoTradeEnabled(next);
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-xl bg-violet-100">
              <CircleDollarSign className="w-5 h-5 text-violet-600" />
            </div>
            <h1 className="text-xl font-bold text-[hsl(var(--foreground))]">Options Wheel Engine</h1>
          </div>
          <p className="text-sm text-[hsl(var(--muted-foreground))] ml-12">
            Sell puts on quality stocks you'd own. Collect premium. Compound returns.
          </p>
        </div>

        {/* Auto-trade toggle */}
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all',
              autoTradeEnabled
                ? 'bg-violet-600 text-white shadow-md shadow-violet-500/30 hover:bg-violet-700'
                : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]/80',
              toggling && 'opacity-60 cursor-not-allowed'
            )}
          >
            {autoTradeEnabled
              ? <Zap className="w-4 h-4" />
              : <ZapOff className="w-4 h-4" />
            }
            {autoTradeEnabled ? 'Auto-Trade ON' : 'Auto-Trade OFF'}
          </button>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))] text-right max-w-[160px]">
            {autoTradeEnabled
              ? 'Morning scan will place real IB orders'
              : 'Paper-trading only — no real orders'}
          </p>
        </div>
      </div>

      {/* Main content */}
      <OptionsTab />
    </div>
  );
}
