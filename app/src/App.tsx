import { useState, useEffect, useCallback } from 'react';
import { Briefcase, Lightbulb, Plus, RefreshCw, Settings } from 'lucide-react';
import type { ActiveTab, StockWithConviction, RiskProfile } from './types';
import { getUserData, addStock, addTickers, updateStock, clearAllData } from './lib/storage';
import { getConvictionResult } from './lib/convictionEngine';
import { calculatePortfolioWeights } from './lib/portfolioCalc';
import { getStockData, fetchMultipleStocks } from './lib/stockApiEdge';
import { generateRuleBased } from './lib/aiInsights';
import { getRiskProfile, setRiskProfile, calculateDrawdown } from './lib/settingsStorage';
import { cn } from './lib/utils';

// Components
import { Dashboard } from './components/Dashboard';
import { SuggestedFinds } from './components/SuggestedFinds';
import { StockDetail } from './components/StockDetail';
import { AddTickersModal } from './components/AddTickersModal';
import SettingsModal from './components/SettingsModal';

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('portfolio');
  const [stocks, setStocks] = useState<StockWithConviction[]>([]);
  const [selectedStock, setSelectedStock] = useState<StockWithConviction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [riskProfile, setRiskProfileState] = useState<RiskProfile>(getRiskProfile());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<string | null>(null);
  const [portfolioDrawdown, setPortfolioDrawdown] = useState<number | null>(null);
  const [hasAutoRefreshed, setHasAutoRefreshed] = useState(false);

  // Load and process stocks
  const loadStocks = useCallback(() => {
    const data = getUserData();

    // Calculate conviction for each stock (100% automated)
    const stocksWithConviction: StockWithConviction[] = data.stocks.map(stock => {
      // Check if stock has real data or is still loading
      const hasRealData =
        stock.qualityScore !== undefined &&
        stock.momentumScore !== undefined &&
        stock.earningsScore !== undefined &&
        stock.analystScore !== undefined;

      const inputs = {
        qualityScore: stock.qualityScore ?? 50,
        momentumScore: stock.momentumScore ?? 50,
        earningsScore: stock.earningsScore ?? 50,
        analystScore: stock.analystScore ?? 50,
      };

      // Determine if fundamental metrics data is available
      const hasMetricsData =
        (stock.peRatio !== null && stock.peRatio !== undefined) ||
        (stock.eps !== null && stock.eps !== undefined);

      return {
        ...stock,
        conviction: getConvictionResult(inputs, hasMetricsData),
        isLoading: !hasRealData, // Mark as loading if data is missing
      };
    });

    // Add portfolio weights
    const withWeights = calculatePortfolioWeights(stocksWithConviction);

    // Recalculate conviction and buy priority with portfolio weight context
    const withPortfolioContext = withWeights.map(stock => {
      const inputs = {
        qualityScore: stock.qualityScore ?? 50,
        momentumScore: stock.momentumScore ?? 50,
        earningsScore: stock.earningsScore ?? 50,
        analystScore: stock.analystScore ?? 50,
      };
      const hasMetricsData =
        (stock.peRatio !== null && stock.peRatio !== undefined) ||
        (stock.eps !== null && stock.eps !== undefined);

      // Calculate rule-based buy priority (instant, no API)
      const { buyPriority } = generateRuleBased(
        inputs.qualityScore,
        inputs.earningsScore,
        inputs.momentumScore,
        stock.portfolioWeight,
        stock.shares,
        stock.avgCost,
        stock.priceChangePercent,
        stock.currentPrice,
        riskProfile
      );

      return {
        ...stock,
        conviction: getConvictionResult(inputs, hasMetricsData, stock.portfolioWeight),
        buyPriority: buyPriority ?? undefined,
      };
    });

    // Calculate portfolio drawdown
    const totalValue = withPortfolioContext.reduce(
      (sum, stock) => sum + (stock.positionValue || 0),
      0
    );
    if (totalValue > 0) {
      const drawdown = calculateDrawdown(totalValue);
      setPortfolioDrawdown(drawdown);
    }

    setStocks(withPortfolioContext);
  }, [riskProfile]);

  // Initial load
  useEffect(() => {
    loadStocks();
  }, [loadStocks]);

  // Auto-refresh when stocks are loaded and have missing scores
  useEffect(() => {
    // Skip if already refreshed, currently refreshing, or no stocks
    if (hasAutoRefreshed || isRefreshing || stocks.length === 0) {
      return;
    }

    // Check if any stock has default/missing scores
    const data = getUserData();
    const needsRefresh = data.stocks.some(
      stock =>
        !stock.qualityScore || !stock.momentumScore || !stock.earningsScore || !stock.analystScore
    );

    if (needsRefresh) {
      setHasAutoRefreshed(true); // Prevent multiple auto-refreshes
      // Small delay to let UI render
      setTimeout(() => {
        handleRefreshAll();
      }, 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocks, isRefreshing, hasAutoRefreshed]); // Watch stocks state

  // Handle adding tickers with Yahoo Finance fetch
  const handleAddTickers = async (tickers: string[]) => {
    // First add tickers to storage
    const result = addTickers(tickers);
    setHasAutoRefreshed(false); // Allow auto-refresh for new stocks
    loadStocks();

    // Fetch data from Finnhub
    if (result.added.length > 0) {
      setIsRefreshing(true);
      setRefreshProgress(`Fetching data for ${result.added.length} stocks...`);

      try {
        const stockData = await fetchMultipleStocks(result.added, (completed, total, current) => {
          setRefreshProgress(`Fetching ${current}... (${completed + 1}/${total})`);
        });

        // Update stocks with fetched data
        stockData.forEach((data, ticker) => {
          updateStock(ticker, {
            name: data.name,
            currentPrice: data.currentPrice,
            priceChange: data.change,
            priceChangePercent: data.changePercent,
            volume: data.volume,
            qualityScore: data.qualityScore,
            momentumScore: data.momentumScore,
            earningsScore: data.earningsScore,
            analystScore: data.analystScore,
            analystRating: data.analystRating || undefined,
            quarterlyEPS: data.quarterlyEPS,
            eps: data.eps,
            peRatio: data.peRatio,
            roe: data.roe,
            profitMargin: data.profitMargin,
            operatingMargin: data.operatingMargin,
          });
        });

        loadStocks();
        setRefreshProgress(`✓ Added ${stockData.size} stocks with data!`);
        setTimeout(() => setRefreshProgress(null), 2000);
      } catch (error) {
        console.error('Failed to fetch stock data:', error);
        setRefreshProgress('⚠️ Some data may be incomplete');
        setTimeout(() => setRefreshProgress(null), 3000);
      } finally {
        setIsRefreshing(false);
      }
    }
  };

  // Handle adding from suggested
  const handleAddFromSuggested = async (ticker: string, name: string) => {
    try {
      addStock({ ticker, name });
      loadStocks();

      // Fetch real data
      setRefreshProgress(`Fetching ${ticker}...`);
      const data = await getStockData(ticker);
      if (data) {
        updateStock(ticker, {
          name: data.name,
          currentPrice: data.currentPrice,
          priceChange: data.change,
          priceChangePercent: data.changePercent,
          volume: data.volume,
          qualityScore: data.qualityScore,
          momentumScore: data.momentumScore,
          earningsScore: data.earningsScore,
          analystScore: data.analystScore,
          analystRating: data.analystRating || undefined,
          quarterlyEPS: data.quarterlyEPS,
          eps: data.eps,
          peRatio: data.peRatio,
          roe: data.roe,
          profitMargin: data.profitMargin,
          operatingMargin: data.operatingMargin,
        });
        loadStocks();
      }
      setRefreshProgress(null);
    } catch {
      // Already exists, ignore
    }
  };

  // Refresh all stock data
  const handleRefreshAll = async () => {
    const tickers = stocks.map(s => s.ticker);
    if (tickers.length === 0) return;

    setIsRefreshing(true);
    setRefreshProgress('Refreshing from Finnhub...');

    try {
      const stockData = await fetchMultipleStocks(tickers, (completed, total, current) => {
        setRefreshProgress(`Refreshing ${current}... (${completed + 1}/${total})`);
      });

      let updated = 0;
      stockData.forEach((data, ticker) => {
        updateStock(ticker, {
          name: data.name,
          currentPrice: data.currentPrice,
          priceChange: data.change,
          priceChangePercent: data.changePercent,
          volume: data.volume,
          qualityScore: data.qualityScore,
          momentumScore: data.momentumScore,
          earningsScore: data.earningsScore,
          analystScore: data.analystScore,
          analystRating: data.analystRating || undefined,
          quarterlyEPS: data.quarterlyEPS,
          eps: data.eps,
          peRatio: data.peRatio,
          roe: data.roe,
          profitMargin: data.profitMargin,
          operatingMargin: data.operatingMargin,
        });
        updated++;
      });

      loadStocks();
      setRefreshProgress(`✓ Updated ${updated} stocks!`);
      setTimeout(() => setRefreshProgress(null), 2000);
    } catch (error) {
      console.error('Failed to refresh:', error);
      setRefreshProgress(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setTimeout(() => setRefreshProgress(null), 5000);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Clear all portfolio data
  const handleClearAll = () => {
    clearAllData();
    setStocks([]);
    setSelectedStock(null);
  };

  // Handle risk profile change
  const handleRiskProfileChange = (newProfile: RiskProfile) => {
    setRiskProfile(newProfile); // Save to localStorage
    setRiskProfileState(newProfile); // Update state
    loadStocks(); // Recalculate with new profile
  };

  // Get existing tickers for suggested tab
  const existingTickers = stocks.map(s => s.ticker);

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-lg border-b border-[hsl(var(--border))]">
        <div className="max-w-4xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[hsl(var(--foreground))] tracking-tight">
                Portfolio Assistant
              </h1>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
                Data-driven conviction scores
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* Drawdown Indicator */}
              {portfolioDrawdown !== null && portfolioDrawdown < -5 && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium">
                  <span>📉 Drawdown: {portfolioDrawdown.toFixed(1)}%</span>
                </div>
              )}

              {/* Settings Button */}
              <button
                onClick={() => setShowSettingsModal(true)}
                className="p-2.5 rounded-xl bg-[hsl(var(--secondary))] hover:bg-[hsl(var(--border))] transition-colors"
                title={`Risk Profile: ${riskProfile.charAt(0).toUpperCase() + riskProfile.slice(1)}`}
              >
                <Settings className="w-5 h-5" />
              </button>

              {/* Refresh Button */}
              {stocks.length > 0 && (
                <button
                  onClick={handleRefreshAll}
                  disabled={isRefreshing}
                  className={cn(
                    'p-2.5 rounded-xl bg-[hsl(var(--secondary))] hover:bg-[hsl(var(--border))] transition-colors',
                    isRefreshing && 'opacity-50 cursor-not-allowed'
                  )}
                  title="Refresh stock data"
                >
                  <RefreshCw className={cn('w-5 h-5', isRefreshing && 'animate-spin')} />
                </button>
              )}

              {/* Add Stocks Button */}
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-2 px-5 py-2.5 bg-[hsl(var(--primary))] text-white rounded-xl hover:bg-[hsl(221,83%,48%)] shadow-lg shadow-blue-500/20 text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                Add Stocks
              </button>
            </div>
          </div>

          {/* Progress indicator */}
          {refreshProgress && (
            <div className="mt-3 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm">
              {refreshProgress}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-2 mt-6">
            <button
              onClick={() => setActiveTab('portfolio')}
              className={cn(
                'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all',
                activeTab === 'portfolio'
                  ? 'bg-[hsl(var(--foreground))] text-white shadow-md'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))]'
              )}
            >
              <Briefcase className="w-4 h-4" />
              My Portfolio
              {stocks.length > 0 && (
                <span
                  className={cn(
                    'ml-1 px-2 py-0.5 text-xs rounded-full',
                    activeTab === 'portfolio' ? 'bg-white/20' : 'bg-[hsl(var(--muted))]'
                  )}
                >
                  {stocks.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('suggested')}
              className={cn(
                'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all',
                activeTab === 'suggested'
                  ? 'bg-[hsl(var(--foreground))] text-white shadow-md'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))]'
              )}
            >
              <Lightbulb className="w-4 h-4" />
              Suggested Finds
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        {activeTab === 'portfolio' ? (
          <Dashboard
            stocks={stocks}
            onStockSelect={setSelectedStock}
            onAddTickers={() => setShowAddModal(true)}
            onClearAll={handleClearAll}
          />
        ) : (
          <SuggestedFinds existingTickers={existingTickers} onAddStock={handleAddFromSuggested} />
        )}
      </main>

      {/* Stock Detail Slide-over */}
      {selectedStock && (
        <StockDetail
          stock={selectedStock}
          onClose={() => setSelectedStock(null)}
          onUpdate={() => {
            loadStocks();
            // Update selected stock reference - need to find in the updated stocks array
            // This is a simplification; the full solution would refresh conviction
          }}
        />
      )}

      {/* Add Tickers Modal */}
      {showAddModal && (
        <AddTickersModal onClose={() => setShowAddModal(false)} onAddTickers={handleAddTickers} />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        currentProfile={riskProfile}
        onProfileChange={handleRiskProfileChange}
      />
    </div>
  );
}

export default App;
