import { useState } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '../lib/utils';
import { Modal } from './Modal';
import { ImportPortfolioModal } from './ImportPortfolioModal';

interface AddTickersModalProps {
  onClose: () => void;
  onAddTickers: (tickers: string[]) => void;
}

type Tab = 'manual' | 'import';

export function AddTickersModal({ onClose, onAddTickers }: AddTickersModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('manual');
  const [tickerInput, setTickerInput] = useState('');
  const [showImport, setShowImport] = useState(false);

  // Auto-open import modal when switching to import tab
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === 'import') {
      setShowImport(true);
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Parse tickers (comma, space, or newline separated)
    const tickers = tickerInput
      .split(/[,\s\n]+/)
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0 && t.length <= 5);

    if (tickers.length > 0) {
      onAddTickers(tickers);
      onClose();
    }
  };

  if (showImport) {
    return (
      <ImportPortfolioModal
        onClose={() => {
          setShowImport(false);
          setActiveTab('manual'); // Return to manual tab when closed
        }}
        onComplete={addedTickers => {
          setShowImport(false);
          onClose();
          // Trigger data fetch for imported stocks
          if (addedTickers.length > 0) {
            onAddTickers(addedTickers);
          }
        }}
      />
    );
  }

  return (
    <Modal title="Add Stocks" onClose={onClose}>
      {/* Tabs */}
      <div className="flex border-b border-[hsl(var(--border))] -mx-6 -mt-5 mb-5 px-6">
        <button
          onClick={() => handleTabChange('manual')}
          className={cn(
            'flex-1 px-4 py-3 text-sm font-medium transition-colors',
            activeTab === 'manual'
              ? 'text-[hsl(var(--primary))] border-b-2 border-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
          )}
        >
          Enter Tickers
        </button>
        <button
          onClick={() => handleTabChange('import')}
          className={cn(
            'flex-1 px-4 py-3 text-sm font-medium transition-colors',
            activeTab === 'import'
              ? 'text-[hsl(var(--primary))] border-b-2 border-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
          )}
        >
          Import Portfolio
        </button>
      </div>

      {activeTab === 'manual' ? (
        <form onSubmit={handleManualSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Ticker Symbols</label>
            <textarea
              value={tickerInput}
              onChange={e => setTickerInput(e.target.value)}
              placeholder="AAPL, MSFT, GOOGL&#10;or one per line"
              className="w-full h-32 px-3 py-2 border border-[hsl(var(--border))] rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
              autoFocus
            />
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
              Separate with commas, spaces, or new lines
            </p>
          </div>

          <button
            type="submit"
            disabled={!tickerInput.trim()}
            className="w-full py-3 bg-[hsl(var(--primary))] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add Tickers
          </button>
        </form>
      ) : (
        <div className="text-center py-8">
          <Upload className="w-12 h-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="font-medium mb-2">Import from Brokerage</h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
            Upload a CSV or Excel file with your holdings
          </p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
            Click below to select your file
          </p>
        </div>
      )}
    </Modal>
  );
}
