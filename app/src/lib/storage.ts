import type { UserData, Stock } from '../types';

const STORAGE_KEY = 'portfolio-assistant-data';

/**
 * Get all user data from localStorage.
 */
export function getUserData(): UserData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return getDefaultData();
    }
    return JSON.parse(raw) as UserData;
  } catch {
    return getDefaultData();
  }
}

/**
 * Save all user data to localStorage.
 */
export function saveUserData(data: UserData): void {
  data.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Add a new stock to the portfolio.
 */
export function addStock(stock: { ticker: string; name?: string }): Stock {
  const data = getUserData();
  
  // Check if already exists
  if (data.stocks.some(s => s.ticker.toUpperCase() === stock.ticker.toUpperCase())) {
    throw new Error(`${stock.ticker} is already in your portfolio`);
  }
  
  const newStock: Stock = {
    ticker: stock.ticker.toUpperCase(),
    name: stock.name || stock.ticker.toUpperCase(),
    dateAdded: new Date().toISOString(),
  };
  
  data.stocks.push(newStock);
  saveUserData(data);
  
  return newStock;
}

/**
 * Update an existing stock.
 */
export function updateStock(ticker: string, updates: Partial<Stock>): Stock | null {
  const data = getUserData();
  const index = data.stocks.findIndex(s => s.ticker === ticker.toUpperCase());
  
  if (index === -1) return null;
  
  data.stocks[index] = { ...data.stocks[index], ...updates };
  saveUserData(data);
  
  return data.stocks[index];
}

/**
 * Remove a stock from the portfolio.
 */
export function removeStock(ticker: string): boolean {
  const data = getUserData();
  const initialLength = data.stocks.length;
  
  data.stocks = data.stocks.filter(s => s.ticker !== ticker.toUpperCase());
  
  if (data.stocks.length < initialLength) {
    saveUserData(data);
    return true;
  }
  
  return false;
}

/**
 * Get default data structure.
 */
function getDefaultData(): UserData {
  return {
    stocks: [],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Add multiple tickers at once (bulk import).
 */
export function addTickers(tickers: string[]): { added: string[]; skipped: string[] } {
  const data = getUserData();
  const added: string[] = [];
  const skipped: string[] = [];
  
  for (const ticker of tickers) {
    const normalized = ticker.trim().toUpperCase();
    if (!normalized) continue;
    
    if (data.stocks.some(s => s.ticker === normalized)) {
      skipped.push(normalized);
      continue;
    }
    
    const newStock: Stock = {
      ticker: normalized,
      name: normalized, // Will be updated when fetching data
      dateAdded: new Date().toISOString(),
    };
    
    data.stocks.push(newStock);
    added.push(normalized);
  }
  
  if (added.length > 0) {
    saveUserData(data);
  }
  
  return { added, skipped };
}

/**
 * Import stocks with position data from parsed CSV/Excel.
 */
export function importStocksWithPositions(
  stocks: Array<{ ticker: string; name?: string; shares?: number; avgCost?: number }>
): { added: string[]; updated: string[]; skipped: string[] } {
  const data = getUserData();
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  
  for (const stock of stocks) {
    const normalized = stock.ticker.trim().toUpperCase();
    if (!normalized) {
      skipped.push(stock.ticker || 'empty');
      continue;
    }
    
    const existingIndex = data.stocks.findIndex(s => s.ticker === normalized);
    
    if (existingIndex !== -1) {
      // Update existing stock with position data
      const updatedStock: Stock = {
        ...data.stocks[existingIndex],
        name: stock.name || data.stocks[existingIndex].name,
      };
      
      // Only set shares/avgCost if provided (undefined means user didn't map those columns)
      // Explicitly delete old values if new import has empty columns
      if (stock.shares !== undefined) {
        updatedStock.shares = stock.shares;
      } else {
        delete updatedStock.shares; // Clear old value if not in new import
      }
      
      if (stock.avgCost !== undefined) {
        updatedStock.avgCost = stock.avgCost;
      } else {
        delete updatedStock.avgCost; // Clear old value if not in new import
      }
      
      data.stocks[existingIndex] = updatedStock;
      updated.push(normalized);
    } else {
      // Add new stock
      const newStock: Stock = {
        ticker: normalized,
        name: stock.name || normalized,
        dateAdded: new Date().toISOString(),
      };
      
      // Only add position data if provided
      if (stock.shares !== undefined) {
        newStock.shares = stock.shares;
      }
      if (stock.avgCost !== undefined) {
        newStock.avgCost = stock.avgCost;
      }
      
      data.stocks.push(newStock);
      added.push(normalized);
    }
  }
  
  if (added.length > 0 || updated.length > 0) {
    saveUserData(data);
  }
  
  return { added, updated, skipped };
}

/**
 * Export data for backup.
 */
export function exportData(): string {
  return JSON.stringify(getUserData(), null, 2);
}

/**
 * Import data from backup.
 */
export function importData(json: string): void {
  const data = JSON.parse(json) as UserData;
  saveUserData(data);
}

/**
 * Clear all data (reset).
 */
export function clearAllData(): void {
  localStorage.removeItem(STORAGE_KEY);
}
