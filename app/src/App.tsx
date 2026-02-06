import { useState, useEffect, useCallback } from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Briefcase, Brain, Lightbulb, Plus, RefreshCw, TrendingUp } from 'lucide-react';
import type { ActiveTab, StockWithConviction, RiskProfile } from './types';
import { getUserData, addTickers, updateStock, clearAllData } from './lib/storage';
import { getConvictionResult } from './lib/convictionEngine';
import { calculatePortfolioWeights } from './lib/portfolioCalc';
import { fetchMultipleStocks } from './lib/stockApiEdge';
import { generateAIInsights } from './lib/aiInsights';
import { getRiskProfile, setRiskProfile } from './lib/settingsStorage';
import { cn } from './lib/utils';

// Components
import { Dashboard } from './components/Dashboard';
import { SuggestedFinds } from './components/SuggestedFinds';
import { MarketMovers } from './components/MarketMovers';
import { StockDetail } from './components/StockDetail';
import { AddTickersModal } from './components/AddTickersModal';

// Zero API calls — rotate through legendary quotes by day-of-year
const INVESTING_QUOTES = [
  '"Be fearful when others are greedy, and greedy when others are fearful." — Warren Buffett',
  '"The stock market is a device for transferring money from the impatient to the patient." — Warren Buffett',
  '"In the short run, the market is a voting machine but in the long run, it is a weighing machine." — Benjamin Graham',
  '"The individual investor should act consistently as an investor and not as a speculator." — Benjamin Graham',
  '"Know what you own, and know why you own it." — Peter Lynch',
  '"The best stock to buy is the one you already own." — Peter Lynch',
  '"Go for a business that any idiot can run — because sooner or later, any idiot is going to run it." — Peter Lynch',
  "\"It's not whether you're right or wrong that's important, but how much money you make when you're right and how much you lose when you're wrong.\" — George Soros",
  '"The most important thing is to find the best investment and concentrate on that." — Charlie Munger',
  '"All intelligent investing is value investing." — Charlie Munger',
  '"The big money is not in the buying and selling, but in the waiting." — Charlie Munger',
  '"An investment in knowledge pays the best interest." — Benjamin Franklin',
  '"Risk comes from not knowing what you\'re doing." — Warren Buffett',
  "\"The four most dangerous words in investing are: 'This time it's different.'\" — John Templeton",
  '"Bull markets are born on pessimism, grow on skepticism, mature on optimism, and die on euphoria." — John Templeton',
  '"The time of maximum pessimism is the best time to buy." — John Templeton',
  '"Investing should be more like watching paint dry or watching grass grow. If you want excitement, take $800 and go to Las Vegas." — Paul Samuelson',
  '"The secret to investing is to figure out the value of something — and then pay a lot less." — Joel Greenblatt',
  '"You make most of your money in a bear market, you just don\'t realize it at the time." — Shelby Davis',
  '"The stock market is filled with individuals who know the price of everything, but the value of nothing." — Philip Fisher',
  '"I will tell you how to become rich. Close the doors. Be fearful when others are greedy. Be greedy when others are fearful." — Warren Buffett',
  '"Compound interest is the eighth wonder of the world." — Albert Einstein',
  '"The goal of a successful trader is to make the best trades. Money is secondary." — Alexander Elder',
  '"Do not put all your eggs in one basket." — Andrew Carnegie',
  '"Behind every stock is a company. Find out what it\'s doing." — Peter Lynch',
  '"The key to making money in stocks is not to get scared out of them." — Peter Lynch',
  '"If you don\'t study any companies, you have the same success buying stocks as you do in a poker game if you bet without looking at your cards." — Peter Lynch',
  '"Wide diversification is only required when investors do not understand what they are doing." — Warren Buffett',
  '"Price is what you pay. Value is what you get." — Warren Buffett',
  '"The intelligent investor is a realist who sells to optimists and buys from pessimists." — Benjamin Graham',
];

function getDailyQuote(): string {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000
  );
  return INVESTING_QUOTES[dayOfYear % INVESTING_QUOTES.length];
}

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('portfolio');
  const [stocks, setStocks] = useState<StockWithConviction[]>([]);
  const [selectedStock, setSelectedStock] = useState<StockWithConviction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const [riskProfile, setRiskProfileState] = useState<RiskProfile>(getRiskProfile());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<string | null>(null);
  const [aiProgress, setAiProgress] = useState<{
    current: string;
    done: number;
    total: number;
  } | null>(null);
  const [hasAutoRefreshed, setHasAutoRefreshed] = useState(false);
  const investingQuote = getDailyQuote(); // Synchronous — zero API calls

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

    // Recalculate conviction with portfolio weight context
    // BUY/SELL signals come ONLY from AI analysis (runs on refresh), not rule-based
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

      return {
        ...stock,
        conviction: getConvictionResult(inputs, hasMetricsData, stock.portfolioWeight),
        // No BUY/SELL signals on load — AI sets these after explicit refresh
      };
    });


    // Show rule-based results instantly — AI runs separately after fresh data
    setStocks(withPortfolioContext);
    return withPortfolioContext;
  }, [riskProfile]);

  // In-flight guard: prevent overlapping runAIAnalysis calls
  // (initial load + auto-refresh + StrictMode can cause concurrent runs)
  const aiInFlight = useState(false);
  const isAIRunning = aiInFlight[0];
  const setIsAIRunning = aiInFlight[1];

  // Per-stock AI analysis — staggered 2s apart to stay within Groq free-tier limits.
  // llama-3.1-8b-instant: 500K TPD, 131K TPM, 30 RPM — very generous.
  // Each stock gets its own AI call (cached for 4h). Same insight is used
  // on main card AND expanded card — no disagreement possible.
  // Cached stocks return instantly (no delay needed).
  // profileOverride: pass directly when changing risk profile to avoid stale closure
  // onComplete: optional callback when analysis finishes (used for risk profile change UX)
  const runAIAnalysis = useCallback(
    async (stockList: StockWithConviction[], profileOverride?: RiskProfile, onComplete?: () => void) => {
      const activeProfile = profileOverride ?? riskProfile;

      // Prevent overlapping runs
      if (isAIRunning) {
        console.log('[AI] Analysis already in progress, skipping');
        return;
      }
      setIsAIRunning(true);

      let uncachedCount = 0;
      const failedStocks: StockWithConviction[] = [];
      const total = stockList.length;

      try {
        for (let i = 0; i < stockList.length; i++) {
          const stock = stockList[i];
          setAiProgress({ current: stock.ticker, done: i, total });

          try {
            const insight = await generateAIInsights(
              stock,
              stock.qualityScore ?? 50,
              stock.earningsScore ?? 50,
              stock.analystScore ?? 50,
              stock.momentumScore ?? 50,
              stock.portfolioWeight,
              stock.shares,
              stock.avgCost,
              stock.priceChangePercent,
              stock.analystRating,
              activeProfile,
              stock.volume,
              stock.recentNews
            );

            if (insight) {
              if (!insight.cached) uncachedCount++;

              // AI is the single source of truth — update card directly
              setStocks(prev =>
                prev.map(s => {
                  if (s.ticker !== stock.ticker) return s;
                  return {
                    ...s,
                    buyPriority: insight.buyPriority ?? undefined,
                    buyPriorityReasoning: insight.cardNote || insight.reasoning,
                  };
                })
              );

              // 4s gap keeps us under 70B's 6K TPM; fallback handles overflow
              if (!insight.cached && i < stockList.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 4000));
              }
            }
          } catch (err) {
            console.warn(`[AI] Failed for ${stock.ticker}:`, err);
            failedStocks.push(stock);
            if (i < stockList.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }
        }

        // Retry any failed stocks after a cooldown
        if (failedStocks.length > 0) {
          console.log(`[AI] Retrying ${failedStocks.length} failed stock(s) after cooldown...`);
          setAiProgress({
            current: 'waiting to retry...',
            done: total - failedStocks.length,
            total,
          });
          await new Promise(resolve => setTimeout(resolve, 10000));

          for (let i = 0; i < failedStocks.length; i++) {
            const stock = failedStocks[i];
            setAiProgress({
              current: `retrying ${stock.ticker}`,
              done: total - failedStocks.length + i,
              total,
            });
            try {
              const insight = await generateAIInsights(
                stock,
                stock.qualityScore ?? 50,
                stock.earningsScore ?? 50,
                stock.analystScore ?? 50,
                stock.momentumScore ?? 50,
                stock.portfolioWeight,
                stock.shares,
                stock.avgCost,
                stock.priceChangePercent,
                stock.analystRating,
                activeProfile,
                stock.volume,
                stock.recentNews
              );

              if (insight) {
                if (!insight.cached) uncachedCount++;
                setStocks(prev =>
                  prev.map(s => {
                    if (s.ticker !== stock.ticker) return s;
                    return {
                      ...s,
                      buyPriority: insight.buyPriority ?? undefined,
                      buyPriorityReasoning: insight.cardNote || insight.reasoning,
                    };
                  })
                );
                if (!insight.cached && i < failedStocks.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 4000));
                }
              }
            } catch (retryErr) {
              console.warn(`[AI] Retry also failed for ${stock.ticker}:`, retryErr);
            }
          }
        }
      } finally {
        setIsAIRunning(false);
        setAiProgress(null);
        if (onComplete) onComplete();
        if (uncachedCount > 0) {
          console.log(`[AI] Completed: ${uncachedCount} fresh API calls, rest from cache`);
        }
      }
    },
    [riskProfile, isAIRunning, setIsAIRunning]
  );

  // Initial load — show stocks with rule-based data; AI only runs on explicit refresh
  useEffect(() => {
    loadStocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const timestamp = new Date().toISOString();
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
            recentNews: data.recentNews,
            eps: data.eps,
            peRatio: data.peRatio,
            roe: data.roe,
            profitMargin: data.profitMargin,
            operatingMargin: data.operatingMargin,
            fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: data.fiftyTwoWeekLow,
            lastDataFetch: timestamp,
            // No previousScore for brand new stocks
          });
        });

        const freshStocks = loadStocks();
        if (freshStocks) runAIAnalysis(freshStocks);
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

  // Note: Stock adding is now only through the Add Tickers modal on the portfolio tab.
  // Suggested Finds and Market Movers are read-only discovery tabs.

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
      let failed = 0;
      const timestamp = new Date().toISOString();

      tickers.forEach(ticker => {
        const data = stockData.get(ticker);

        if (!data) {
          // Stock failed to fetch
          failed++;
          return;
        }

        // Capture current score as previousScore before updating
        const currentStock = stocks.find(s => s.ticker === ticker);
        const currentScore = currentStock
          ? getConvictionResult(
              {
                qualityScore: currentStock.qualityScore ?? 50,
                momentumScore: currentStock.momentumScore ?? 50,
                earningsScore: currentStock.earningsScore ?? 50,
                analystScore: currentStock.analystScore ?? 50,
              },
              true
            ).score
          : undefined;

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
          recentNews: data.recentNews,
          eps: data.eps,
          peRatio: data.peRatio,
          roe: data.roe,
          profitMargin: data.profitMargin,
          operatingMargin: data.operatingMargin,
          fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: data.fiftyTwoWeekLow,
          lastDataFetch: timestamp,
          previousScore: currentScore,
        });
        updated++;
      });

      const freshStocks = loadStocks();

      // NOW fire AI with fresh data — the only place this runs
      if (freshStocks) runAIAnalysis(freshStocks);

      if (failed > 0) {
        setRefreshProgress(`✓ Updated ${updated} stocks. ${failed} failed - using cached data.`);
      } else {
        setRefreshProgress(`✓ Updated ${updated} stocks!`);
      }

      setTimeout(() => setRefreshProgress(null), 3000);
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

  // Handle risk profile change — pass new profile directly to avoid stale closure
  const handleRiskProfileChange = (newProfile: RiskProfile) => {
    setRiskProfile(newProfile); // Save to localStorage
    setRiskProfileState(newProfile); // Update state

    // Show user that re-analysis is happening (stays visible until done)
    const profileLabel = newProfile.charAt(0).toUpperCase() + newProfile.slice(1);
    setRefreshProgress(`Re-analyzing with ${profileLabel} risk profile...`);

    const freshStocks = loadStocks(); // Recalculate with new profile
    if (freshStocks) {
      // Pass profile directly — React state hasn't updated yet (async)
      runAIAnalysis(freshStocks, newProfile, () => {
        // Show "Done" when analysis completes
        setRefreshProgress(`✓ Done — updated signals for ${profileLabel} profile`);
        setTimeout(() => setRefreshProgress(null), 2500);
      });
    }
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
                AI-powered stock signals — skip the noise, catch the plays
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* Refresh Button — only on portfolio tab */}
              {activeTab === 'portfolio' && stocks.length > 0 && (
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

              {/* Add Stocks Button — only on portfolio tab */}
              {activeTab === 'portfolio' && (
                <button
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-[hsl(var(--primary))] text-white rounded-xl hover:bg-[hsl(221,83%,48%)] shadow-lg shadow-blue-500/20 text-sm font-medium"
                >
                  <Plus className="w-4 h-4" />
                  Add Stocks
                </button>
              )}
            </div>
          </div>

          {/* Progress indicator */}
          {refreshProgress && (
            <div className="mt-3 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm">
              {refreshProgress}
            </div>
          )}

          {/* AI Analysis progress */}
          {aiProgress && (
            <div className="mt-2 px-4 py-2.5 bg-purple-50 text-purple-700 rounded-lg text-sm">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <Brain className="w-4 h-4 animate-pulse" />
                  <span className="font-medium">AI analyzing {aiProgress.current}...</span>
                </div>
                <span className="text-purple-500 tabular-nums">
                  {aiProgress.done}/{aiProgress.total}
                </span>
              </div>
              <div className="w-full bg-purple-200 rounded-full h-1.5">
                <div
                  className="bg-purple-500 h-1.5 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.round((aiProgress.done / aiProgress.total) * 100)}%` }}
                />
              </div>
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
            <button
              onClick={() => setActiveTab('movers')}
              className={cn(
                'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all',
                activeTab === 'movers'
                  ? 'bg-[hsl(var(--foreground))] text-white shadow-md'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))]'
              )}
            >
              <TrendingUp className="w-4 h-4" />
              Market Movers
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
            riskProfile={riskProfile}
            onRiskProfileChange={handleRiskProfileChange}
          />
        ) : activeTab === 'suggested' ? (
          <SuggestedFinds existingTickers={existingTickers} />
        ) : (
          <MarketMovers />
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

      {/* Footer with daily quote */}
      <footer className="max-w-4xl mx-auto px-6 py-6 mt-4">
        <p className="text-xs text-center text-[hsl(var(--muted-foreground))] italic opacity-60">
          {investingQuote}
        </p>
      </footer>

      <SpeedInsights />
    </div>
  );
}

export default App;
