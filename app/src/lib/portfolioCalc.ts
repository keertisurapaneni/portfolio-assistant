import type { Stock, StockWithConviction } from '../types';

/**
 * Calculate position value for a stock.
 * Uses avgCost if available, otherwise falls back to currentPrice.
 * For portfolio weight calculations, current market value is what matters.
 */
export function calculatePositionValue(stock: Stock): number | undefined {
  console.log(
    `[PositionCalc] ${stock.ticker}: shares=${stock.shares}, avgCost=${stock.avgCost}, currentPrice=${stock.currentPrice}`
  );

  if (!stock.shares) {
    console.log(`[PositionCalc] ${stock.ticker}: No shares data`);
    return undefined;
  }

  // Prefer avgCost for original investment value
  if (stock.avgCost) {
    const value = stock.shares * stock.avgCost;
    console.log(`[PositionCalc] ${stock.ticker}: Using avgCost → $${value.toLocaleString()}`);
    return value;
  }

  // Fallback to current market value if avgCost not available
  if (stock.currentPrice) {
    const value = stock.shares * stock.currentPrice;
    console.log(`[PositionCalc] ${stock.ticker}: Using currentPrice → $${value.toLocaleString()}`);
    return value;
  }

  console.log(`[PositionCalc] ${stock.ticker}: No price data available`);
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
  const totalValue = stocksWithValues.reduce((sum, stock) => sum + (stock.positionValue ?? 0), 0);
  console.log(`[PortfolioCalc] Total portfolio value: $${totalValue.toLocaleString()}`);

  // Calculate weights
  const result = stocksWithValues.map(stock => {
    const weight =
      totalValue > 0 && stock.positionValue
        ? Math.round((stock.positionValue / totalValue) * 100)
        : undefined;

    if (weight !== undefined) {
      console.log(
        `[PortfolioCalc] ${stock.ticker}: ${weight}% of portfolio ($${stock.positionValue?.toLocaleString()})`
      );
    }

    return {
      ...stock,
      portfolioWeight: weight,
    };
  });

  return result;
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
