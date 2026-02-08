/**
 * useSuggestedFinds — React hook for AI-powered grounded stock discovery
 *
 * Pipeline: HuggingFace candidates → Finnhub real data → HuggingFace analysis
 * Supports category-focused discovery for Quiet Compounders
 * Exposes step-by-step progress for UX transparency
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { EnhancedSuggestedStock } from '../data/suggestedFinds';
import {
  discoverStocks,
  discoverCategoryStocks,
  clearDiscoveryCache,
  getCachedTimestamp,
  COMPOUNDER_CATEGORIES,
  type ThemeData,
  type DiscoveryResult,
  type DiscoveryStep,
} from '../lib/aiSuggestedFinds';

export { COMPOUNDER_CATEGORIES };

const STEP_LABELS: Record<DiscoveryStep, string> = {
  idle: '',
  finding_candidates: 'Finding candidate stocks...',
  fetching_metrics: 'Fetching real market data...',
  analyzing_compounders: 'Analyzing compounders with real data...',
  fetching_news: 'Fetching market news...',
  analyzing_themes: 'Extracting macro themes from headlines...',
  done: '',
};

export interface UseSuggestedFindsResult {
  compounders: EnhancedSuggestedStock[];
  displayedCompounders: EnhancedSuggestedStock[];
  goldMines: EnhancedSuggestedStock[];
  currentTheme: ThemeData | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
  step: DiscoveryStep;
  stepLabel: string;
  refresh: () => void;
  // Category support
  selectedCategory: string | null;
  setSelectedCategory: (cat: string | null) => void;
  isCategoryLoading: boolean;
  categoryStep: DiscoveryStep;
  categoryStepLabel: string;
  categoryError: string | null;
  discoverCategory: (cat: string) => void;
}

export function useSuggestedFinds(existingTickers: string[]): UseSuggestedFindsResult {
  const [compounders, setCompounders] = useState<EnhancedSuggestedStock[]>([]);
  const [goldMines, setGoldMines] = useState<EnhancedSuggestedStock[]>([]);
  const [currentTheme, setCurrentTheme] = useState<ThemeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [step, setStep] = useState<DiscoveryStep>('idle');

  // Category-focused discovery state
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryCompounders, setCategoryCompounders] = useState<EnhancedSuggestedStock[]>([]);
  const [isCategoryLoading, setIsCategoryLoading] = useState(false);
  const [categoryStep, setCategoryStep] = useState<DiscoveryStep>('idle');
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);
  const tickersRef = useRef<string[]>(existingTickers);
  tickersRef.current = existingTickers;

  const applyResult = useCallback((result: DiscoveryResult) => {
    setCompounders(result.compounders);
    setGoldMines(result.goldMines);
    setCurrentTheme(result.currentTheme);
    setLastUpdated(result.timestamp);
    setError(null);
  }, []);

  const fetchSuggestions = useCallback(
    async (forceRefresh = false) => {
      setIsLoading(true);
      setError(null);
      setStep('idle');

      try {
        const result = await discoverStocks(
          tickersRef.current,
          forceRefresh,
          (newStep) => setStep(newStep)
        );
        applyResult(result);
      } catch (err) {
        console.error('[useSuggestedFinds] Discovery failed:', err);

        if (compounders.length > 0 || goldMines.length > 0) {
          setError('Failed to refresh — showing cached suggestions');
        } else {
          setCompounders([]);
          setGoldMines([]);
          setCurrentTheme(null);
          setError('AI suggestions are unavailable right now. Hit refresh to try again.');
        }
      } finally {
        setIsLoading(false);
        setStep('done');
      }
    },
    [applyResult] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Category-focused discovery
  const discoverCategory = useCallback(
    async (cat: string) => {
      setIsCategoryLoading(true);
      setCategoryStep('idle');
      setCategoryError(null);

      try {
        const results = await discoverCategoryStocks(
          cat,
          tickersRef.current,
          (newStep) => setCategoryStep(newStep)
        );
        setCategoryCompounders(results);
      } catch (err) {
        console.error(`[useSuggestedFinds] Category discovery failed for ${cat}:`, err);
        setCategoryCompounders([]);
        setCategoryError('Discovery failed — try again in a moment.');
      } finally {
        setIsCategoryLoading(false);
        setCategoryStep('done');
      }
    },
    []
  );

  // Reset category results when category changes
  const handleSetSelectedCategory = useCallback((cat: string | null) => {
    setSelectedCategory(cat);
    setCategoryCompounders([]);
    setCategoryStep('idle');
    setCategoryError(null);
  }, []);

  // Compute displayed compounders:
  // - null/Auto: show all compounders from main discovery
  // - Category selected + focused results exist: show focused results
  // - Category selected + no focused results: filter main compounders by category
  const displayedCompounders = useMemo(() => {
    if (!selectedCategory) return compounders;
    if (categoryCompounders.length > 0) return categoryCompounders;

    // Filter existing compounders by category (fuzzy match)
    const catLower = selectedCategory.toLowerCase();
    return compounders.filter((s) =>
      s.category?.toLowerCase().includes(catLower) ||
      catLower.includes(s.category?.toLowerCase() ?? '')
    );
  }, [selectedCategory, compounders, categoryCompounders]);

  // Initial load
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const cachedTimestamp = getCachedTimestamp();
    if (cachedTimestamp) setLastUpdated(cachedTimestamp);

    fetchSuggestions(false);
  }, [fetchSuggestions]);

  const refresh = useCallback(() => {
    clearDiscoveryCache();
    setSelectedCategory(null);
    setCategoryCompounders([]);
    fetchSuggestions(true);
  }, [fetchSuggestions]);

  return {
    compounders,
    displayedCompounders,
    goldMines,
    currentTheme,
    isLoading,
    error,
    lastUpdated,
    step,
    stepLabel: STEP_LABELS[step] || '',
    refresh,
    // Category support
    selectedCategory,
    setSelectedCategory: handleSetSelectedCategory,
    isCategoryLoading,
    categoryStep,
    categoryStepLabel: STEP_LABELS[categoryStep] || '',
    categoryError,
    discoverCategory,
  };
}
