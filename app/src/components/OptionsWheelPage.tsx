import { CircleDollarSign } from 'lucide-react';
import { OptionsTab } from './PaperTrading/tabs/OptionsTab';

/**
 * Top-level Options Wheel page — accessible via /options route.
 *
 * A standalone premium income engine for selling puts and covered calls
 * on quality stocks. Separate from Paper Trading — this is its own product.
 */
export function OptionsWheelPage() {
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
        <div className="text-right hidden sm:block">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Target</p>
          <p className="text-sm font-bold text-violet-600">70–80% annual</p>
        </div>
      </div>

      {/* Main content */}
      <OptionsTab />
    </div>
  );
}
