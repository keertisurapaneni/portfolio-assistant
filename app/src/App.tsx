import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import { Activity, Briefcase, Brain, Lightbulb, RefreshCw, TrendingUp, User, LogOut, ChevronDown } from 'lucide-react';
import type { StockWithConviction, RiskProfile } from './types';
import { getUserData, addTickers, updateStock, removeStock, clearAllData, importStocksWithPositions } from './lib/storage';
import { getCloudUserData, cloudAddTickers, cloudRemoveTicker, cloudClearAll, migrateGuestToCloud } from './lib/cloudStorage';
import { getConvictionResult } from './lib/convictionEngine';
import { calculatePortfolioWeights } from './lib/portfolioCalc';
import { fetchMultipleStocks } from './lib/stockApiEdge';
import { generateAIInsights } from './lib/aiInsights';
import { getRiskProfile, setRiskProfile } from './lib/settingsStorage';
import { cn } from './lib/utils';
import { AuthProvider, useAuth } from './lib/auth';

// Components
import { Dashboard } from './components/Dashboard';
import { SuggestedFinds } from './components/SuggestedFinds';
import { MarketMovers } from './components/MarketMovers';
import { TradingSignals } from './components/TradingSignals';
import { StockDetail } from './components/StockDetail';
import { AddTickersModal } from './components/AddTickersModal';
import { AuthModal } from './components/AuthModal';
import { BrokerConnect } from './components/BrokerConnect';
import type { SyncResult } from './lib/brokerApi';

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

function AppContent() {
  const location = useLocation();
  const { user, loading: authLoading, signOut } = useAuth();
  const isAuthed = !!user;
  const activeTab = location.pathname === '/finds' ? 'suggested' : location.pathname === '/movers' ? 'movers' : location.pathname === '/signals' ? 'signals' : 'portfolio';
  const [stocks, setStocks] = useState<StockWithConviction[]>([]);
  const [selectedStock, setSelectedStock] = useState<StockWithConviction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

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

  // Load and process stocks — async to support cloud storage.
  // Cloud stores portfolio composition (tickers + positions).
  // localStorage always caches market data (prices, scores, etc.).
  // For authed users we merge: cloud ticker list + localStorage market data cache.
  const loadStocks = useCallback(async () => {
    const localData = getUserData(); // Always read — has cached market data
    let data;
    if (isAuthed) {
      // Migrate guest portfolio to cloud on first login (if cloud is empty)
      await migrateGuestToCloud();
      const cloudData = await getCloudUserData();
      // Merge: cloud positions + localStorage cached market data
      data = {
        ...cloudData,
        stocks: cloudData.stocks.map(cs => {
          const cached = localData.stocks.find(s => s.ticker === cs.ticker);
          // Prefer the enriched name (from Finnhub via localStorage) over the stub name (ticker) from cloud
          const enrichedName = (cached?.name && cached.name !== cs.ticker) ? cached.name
            : (cs.name && cs.name !== cs.ticker) ? cs.name
            : cached?.name || cs.name;
          return cached
            ? { ...cached, shares: cs.shares, avgCost: cs.avgCost, name: enrichedName }
            : cs;
        }),
      };
    } else {
      data = localData;
    }

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
  }, [riskProfile, isAuthed]);

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
  // Re-runs when auth state changes (login/logout) to switch storage source
  useEffect(() => {
    if (authLoading) return; // Wait for auth to resolve
    setHasAutoRefreshed(false); // Reset auto-refresh flag on auth change
    loadStocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed, authLoading]);

  // Auto-refresh when stocks are loaded and have missing scores
  useEffect(() => {
    // Skip if already refreshed, currently refreshing, or no stocks
    if (hasAutoRefreshed || isRefreshing || stocks.length === 0) {
      return;
    }

    // Check if any displayed stock is missing market data (scores/prices)
    // Use the actual stocks state — not localStorage — to support authed users
    // whose cloud stocks may not have a localStorage cache yet
    const needsRefresh = stocks.some(
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
    // Always add to localStorage (cache for market data).
    // For authed users, also persist to cloud DB (source of truth for positions).
    const localResult = addTickers(tickers);
    const result = isAuthed ? await cloudAddTickers(tickers) : localResult;

    // Fetch data from Finnhub
    if (result.added.length > 0) {
      // Set refreshing BEFORE loadStocks to prevent auto-refresh from interfering
      setIsRefreshing(true);
      setHasAutoRefreshed(true); // Block auto-refresh during add flow
      setRefreshProgress(`Fetching data for ${result.added.length} stocks...`);
      await loadStocks();

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

        // Detect invalid tickers (not found on Finnhub)
        const invalidTickers = result.added.filter(t => !stockData.has(t));
        if (invalidTickers.length > 0) {
          // Remove invalid tickers from both storages
          for (const t of invalidTickers) {
            removeStock(t);
            if (isAuthed) await cloudRemoveTicker(t);
          }
        }

        const freshStocks = await loadStocks();
        if (freshStocks) runAIAnalysis(freshStocks);

        if (invalidTickers.length > 0 && stockData.size > 0) {
          setRefreshProgress(`✓ Added ${stockData.size} stock${stockData.size > 1 ? 's' : ''}. Invalid: ${invalidTickers.join(', ')}`);
          setTimeout(() => setRefreshProgress(null), 4000);
        } else if (invalidTickers.length > 0 && stockData.size === 0) {
          setRefreshProgress(`⚠️ Ticker${invalidTickers.length > 1 ? 's' : ''} not found: ${invalidTickers.join(', ')}`);
          setTimeout(() => setRefreshProgress(null), 4000);
        } else {
          setRefreshProgress(`✓ Added ${stockData.size} stock${stockData.size > 1 ? 's' : ''} with data!`);
          setTimeout(() => setRefreshProgress(null), 2000);
        }
      } catch (error) {
        console.error('Failed to fetch stock data:', error);
        setRefreshProgress('⚠️ Some data may be incomplete');
        setTimeout(() => setRefreshProgress(null), 3000);
      } finally {
        setIsRefreshing(false);
      }
    } else {
      // All tickers were duplicates — just reload
      await loadStocks();
    }
  };

  // Note: Stock adding is now only through the Add Tickers modal on the portfolio tab.
  // Suggested Finds and Market Movers are read-only discovery tabs.

  // Refresh all stock data
  const handleRefreshAll = async () => {
    const tickers = stocks.map(s => s.ticker);
    if (tickers.length === 0) return;

    // Ensure all displayed tickers exist in localStorage (cache)
    // For authed users, cloud may have tickers not yet in localStorage
    const localData = getUserData();
    const localTickers = new Set(localData.stocks.map(s => s.ticker));
    const missingLocally = tickers.filter(t => !localTickers.has(t));
    if (missingLocally.length > 0) {
      addTickers(missingLocally); // Create stubs so updateStock can write to them
    }

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

      const freshStocks = await loadStocks();

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
  const handleClearAll = async () => {
    if (isAuthed) await cloudClearAll();
    clearAllData();
    setStocks([]);
    setSelectedStock(null);
  };

  // Handle risk profile change — pass new profile directly to avoid stale closure
  const handleRiskProfileChange = async (newProfile: RiskProfile) => {
    setRiskProfile(newProfile); // Save to localStorage
    setRiskProfileState(newProfile); // Update state

    // Show user that re-analysis is happening (stays visible until done)
    const profileLabel = newProfile.charAt(0).toUpperCase() + newProfile.slice(1);
    setRefreshProgress(`Re-analyzing with ${profileLabel} risk profile...`);

    const freshStocks = await loadStocks(); // Recalculate with new profile
    if (freshStocks) {
      // Pass profile directly — React state hasn't updated yet (async)
      runAIAnalysis(freshStocks, newProfile, () => {
        // Show "Done" when analysis completes
        setRefreshProgress(`✓ Done — updated signals for ${profileLabel} profile`);
        setTimeout(() => setRefreshProgress(null), 2500);
      });
    }
  };

  // Handle broker sync — import synced positions and reload
  const handleBrokerSync = async (result: SyncResult) => {
    if (result.positions.length > 0) {
      // Also update localStorage cache with position data
      importStocksWithPositions(result.positions.map(p => ({ ...p, avgCost: p.avgCost ?? undefined })));
      await loadStocks();
      setRefreshProgress(`✓ Synced ${result.stats.total} positions from broker`);
      setTimeout(() => setRefreshProgress(null), 3000);
    }
  };

  // Get existing tickers for suggested tab
  const existingTickers = stocks.map(s => s.ticker);

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-gradient-to-br from-slate-50 via-blue-50/60 to-indigo-50/40 backdrop-blur-xl border-b border-blue-100/60 shadow-sm">
        <div className="max-w-4xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3.5">
              {/* Logo — bull icon */}
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 shadow-lg shadow-blue-500/25 flex items-center justify-center flex-shrink-0">
                <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  {/* Left horn */}
                  <path d="M6 6C5 3 3 2 2 2C4 4 5 7 7 10" stroke="white" strokeWidth="2" strokeLinecap="round" />
                  {/* Right horn */}
                  <path d="M26 6C27 3 29 2 30 2C28 4 27 7 25 10" stroke="white" strokeWidth="2" strokeLinecap="round" />
                  {/* Head */}
                  <path d="M7 10C7 10 6 14 8 17C9 18.5 11 20 12 22L14 25C14.5 26 15 26.5 16 26.5C17 26.5 17.5 26 18 25L20 22C21 20 23 18.5 24 17C26 14 25 10 25 10" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  {/* Ears */}
                  <path d="M8 10C9 9 10 9.5 11 10.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M24 10C23 9 22 9.5 21 10.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  {/* Eyes */}
                  <circle cx="12.5" cy="14" r="1.2" fill="white" />
                  <circle cx="19.5" cy="14" r="1.2" fill="white" />
                  {/* Nostrils */}
                  <circle cx="14" cy="19.5" r="0.8" fill="white" opacity="0.6" />
                  <circle cx="18" cy="19.5" r="0.8" fill="white" opacity="0.6" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">
                  <span className="text-gradient">Portfolio Assistant</span>
                </h1>
                <p className="text-sm text-slate-500 mt-0.5">
                  AI-powered stock signals — skip the noise, catch the plays
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Broker Connect — only for authed users on portfolio tab */}
              {isAuthed && activeTab === 'portfolio' && (
                <BrokerConnect onSyncComplete={handleBrokerSync} />
              )}

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

              {/* Auth: Login button or User menu */}
              {!authLoading && (
                isAuthed ? (
                  <div className="relative">
                    <button
                      onClick={() => setShowUserMenu(v => !v)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[hsl(var(--secondary))] hover:bg-[hsl(var(--border))] transition-colors text-sm"
                    >
                      <User className="w-4 h-4" />
                      <span className="max-w-[100px] truncate text-xs">{user?.email?.split('@')[0]}</span>
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {showUserMenu && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                        <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border p-1 z-50 w-40">
                          <p className="px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))] truncate">{user?.email}</p>
                          <hr className="my-1" />
                          <button
                            onClick={() => { signOut(); setShowUserMenu(false); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded"
                          >
                            <LogOut className="w-3.5 h-3.5" />
                            Sign Out
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[hsl(var(--secondary))] hover:bg-[hsl(var(--border))] transition-colors text-sm font-medium"
                  >
                    <User className="w-4 h-4" />
                    Login
                  </button>
                )
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

          {/* Tabs — NavLinks for client-side routing */}
          <div className="flex gap-1 mt-6 bg-white/60 p-1 rounded-xl border border-blue-100/50">
            <NavLink
              to="/"
              end
              className={({ isActive }) => cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/80'
              )}
            >
              <Briefcase className="w-4 h-4" />
              My Portfolio
              {stocks.length > 0 && (
                <span
                  className={cn(
                    'ml-0.5 px-1.5 py-0.5 text-xs rounded-full font-semibold',
                    activeTab === 'portfolio' ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-500'
                  )}
                >
                  {stocks.length}
                </span>
              )}
            </NavLink>
            <NavLink
              to="/signals"
              className={({ isActive }) => cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/80'
              )}
            >
              <Activity className="w-4 h-4" />
              Trade Signals
            </NavLink>
            <NavLink
              to="/finds"
              className={({ isActive }) => cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/80'
              )}
            >
              <Lightbulb className="w-4 h-4" />
              Suggested Finds
            </NavLink>
            <NavLink
              to="/movers"
              className={({ isActive }) => cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/80'
              )}
            >
              <TrendingUp className="w-4 h-4" />
              Movers
            </NavLink>
          </div>
        </div>
      </header>

      {/* Daily investing quote — below tabs, above content */}
      <div className="max-w-4xl mx-auto px-6 pt-5 pb-0">
        <p className="text-[13px] text-center text-[hsl(var(--primary))]/50 italic leading-relaxed">
          {investingQuote}
        </p>
      </div>

      {/* Main Content — Routed */}
      <main className="max-w-4xl mx-auto px-6 py-6">
        <Routes>
          <Route path="/" element={
            <Dashboard
              stocks={stocks}
              onStockSelect={setSelectedStock}
              onAddTickers={() => setShowAddModal(true)}
              onClearAll={handleClearAll}
              riskProfile={riskProfile}
              onRiskProfileChange={handleRiskProfileChange}
              isAuthed={isAuthed}
              onLogin={() => setShowAuthModal(true)}
              onBrokerSync={handleBrokerSync}
            />
          } />
          <Route path="/finds" element={<SuggestedFinds existingTickers={existingTickers} />} />
          <Route path="/movers" element={<MarketMovers />} />
          <Route path="/signals" element={<TradingSignals />} />
        </Routes>
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

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal onClose={() => setShowAuthModal(false)} />
      )}

      {/* Footer with disclaimer + tech stack link */}
      <footer className="max-w-4xl mx-auto px-6 py-6 mt-4">
        <p className="text-[10px] text-center text-[hsl(var(--muted-foreground))] opacity-50 max-w-2xl mx-auto">
          Not financial advice. AI-generated signals are for informational purposes only and should not be relied upon for investment decisions. Always do your own research and consult a qualified financial advisor. Past performance does not guarantee future results.
        </p>
        <p className="text-xs text-center mt-3 text-[hsl(var(--muted-foreground))]">
          Built by{' '}
          <a
            href="https://www.linkedin.com/in/keerti-s-17629b74"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium hover:text-blue-600 transition-colors"
          >
            Keerti Surapaneni
          </a>
          {' · '}
          <a
            href="/tech-stack.html"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:opacity-80"
          >
            Tech stack
          </a>
        </p>
      </footer>

      <SpeedInsights />
      <Analytics />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
