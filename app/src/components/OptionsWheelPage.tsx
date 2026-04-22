import { CircleDollarSign, Zap } from 'lucide-react';
import { OptionsTab } from './PaperTrading/tabs/OptionsTab';

/**
 * Top-level Options Wheel page — auth required.
 * Auto-trade is controlled via auto_trader_config in the DB, not from the UI.
 */
export function OptionsWheelPage() {
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-violet-100">
              <CircleDollarSign className="w-5 h-5 text-violet-600" />
            </div>
            <h1 className="text-xl font-bold text-[hsl(var(--foreground))]">Options Wheel Engine</h1>
          </div>
          <p className="text-sm text-[hsl(var(--muted-foreground))] ml-12">
            Sell puts on quality stocks you'd own. Collect premium. Compound returns.
          </p>

          {/* Status banner — matches Suggested Finds style */}
          <div className="ml-12 flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-amber-50 text-amber-700 border border-amber-200 w-fit">
            <Zap className="w-3.5 h-3.5 animate-pulse" />
            Auto-scanning and paper trading qualifying puts...
          </div>
        </div>
      </div>

      {/* Main content */}
      <OptionsTab />
    </div>
  );
}
