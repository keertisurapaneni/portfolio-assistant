/**
 * useSuggestedFinds — React hook for AI-powered grounded stock discovery
 *
 * Pipeline: Gemini candidates → Finnhub real data → Gemini analysis
 * Exposes step-by-step progress for UX transparency
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { EnhancedSuggestedStock } from '../data/suggestedFinds';
import {
  discoverStocks,
  clearDiscoveryCache,
  getCachedTimestamp,
  type ThemeData,
  type DiscoveryResult,
  type DiscoveryStep,
} from '../lib/aiSuggestedFinds';

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
  goldMines: EnhancedSuggestedStock[];
  currentTheme: ThemeData | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
  step: DiscoveryStep;
  stepLabel: string;
  refresh: () => void;
}

export function useSuggestedFinds(existingTickers: string[]): UseSuggestedFindsResult {
  const [compounders, setCompounders] = useState<EnhancedSuggestedStock[]>([]);
  const [goldMines, setGoldMines] = useState<EnhancedSuggestedStock[]>([]);
  const [currentTheme, setCurrentTheme] = useState<ThemeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [step, setStep] = useState<DiscoveryStep>('idle');

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
    fetchSuggestions(true);
  }, [fetchSuggestions]);

  return {
    compounders,
    goldMines,
    currentTheme,
    isLoading,
    error,
    lastUpdated,
    step,
    stepLabel: STEP_LABELS[step] || '',
    refresh,
  };
}
