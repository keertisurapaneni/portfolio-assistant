import type { Stock, StockWithConviction } from '../types';

/**
 * Calculate position value for a stock.
 */
export function calculatePositionValue(stock: Stock): number | undefined {
  if (stock.shares && stock.avgCost) {
    return stock.shares * stock.avgCost;
  }
  return undefined;
}

/**
 * Calculate portfolio weights for all stocks.
 * Weight = (position value / total portfolio value) * 100
 */
export function calculatePortfolioWeights(stocks: StockWithConviction[]): StockWithConviction[] {
  // First, calculate position values
  const stocksWithValues = stocks.map(stock => ({
    ...stock,
    positionValue: calculatePositionValue(stock),
  }));
  
  // Calculate total portfolio value
  const totalValue = stocksWithValues.reduce(
    (sum, stock) => sum + (stock.positionValue ?? 0),
    0
  );
  
  // Calculate weights
  return stocksWithValues.map(stock => ({
    ...stock,
    portfolioWeight: totalValue > 0 && stock.positionValue
      ? Math.round((stock.positionValue / totalValue) * 100)
      : undefined,
  }));
}

/**
 * Sort stocks by portfolio weight (descending).
 */
export function sortByWeight(stocks: StockWithConviction[]): StockWithConviction[] {
  return [...stocks].sort((a, b) => {
    const weightA = a.portfolioWeight ?? 0;
    const weightB = b.portfolioWeight ?? 0;
    return weightB - weightA;
  });
}

/**
 * Get stocks that represent a significant portion of the portfolio.
 * Default threshold: 10%
 */
export function getSignificantPositions(
  stocks: StockWithConviction[],
  threshold = 10
): StockWithConviction[] {
  return stocks.filter(stock => (stock.portfolioWeight ?? 0) >= threshold);
}

/**
 * Format position value for display.
 */
export function formatPositionValue(value: number | undefined): string {
  if (value === undefined) return '—';
  
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  } else if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  } else {
    return `$${value.toFixed(0)}`;
  }
}

/**
 * Format shares for display.
 */
export function formatShares(shares: number | undefined): string {
  if (shares === undefined) return '—';
  return shares.toLocaleString();
}

/**
 * Format average cost for display.
 */
export function formatAvgCost(avgCost: number | undefined): string {
  if (avgCost === undefined) return '—';
  return `$${avgCost.toFixed(2)}`;
}
