/**
 * Cloud Storage — Supabase-backed portfolio CRUD for authenticated users.
 * Same logical interface as storage.ts but reads/writes PostgreSQL via RLS.
 */
import { supabase } from './supabaseClient';
import type { Stock, UserData } from '../types';

// ── Read ──

export async function getCloudPortfolio(): Promise<Stock[]> {
  const { data, error } = await supabase
    .from('portfolios')
    .select('ticker, name, shares, avg_cost, date_added')
    .order('date_added', { ascending: true });

  if (error) {
    console.error('[CloudStorage] fetch failed:', error.message);
    return [];
  }

  return (data ?? []).map(row => ({
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    dateAdded: row.date_added,
    shares: row.shares != null ? Number(row.shares) : undefined,
    avgCost: row.avg_cost != null ? Number(row.avg_cost) : undefined,
  }));
}

/** Wrap cloud portfolio in UserData shape for compatibility with loadStocks. */
export async function getCloudUserData(): Promise<UserData> {
  const stocks = await getCloudPortfolio();
  return { stocks, lastUpdated: new Date().toISOString() };
}

// ── Write ──

export async function cloudAddTickers(
  tickers: string[]
): Promise<{ added: string[]; skipped: string[] }> {
  const existing = await getCloudPortfolio();
  const existingSet = new Set(existing.map(s => s.ticker));
  const added: string[] = [];
  const skipped: string[] = [];
  const toInsert: { ticker: string; name: string }[] = [];

  for (const t of tickers) {
    const normalized = t.trim().toUpperCase();
    if (!normalized) continue;
    if (existingSet.has(normalized)) { skipped.push(normalized); continue; }
    toInsert.push({ ticker: normalized, name: normalized });
    added.push(normalized);
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from('portfolios').insert(toInsert);
    if (error) console.error('[CloudStorage] bulk insert failed:', error.message);
  }

  return { added, skipped };
}

export async function cloudUpdateStock(ticker: string, updates: Partial<Stock>): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.shares !== undefined) patch.shares = updates.shares;
  if (updates.avgCost !== undefined) patch.avg_cost = updates.avgCost;
  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase
    .from('portfolios')
    .update(patch)
    .eq('ticker', ticker.toUpperCase());

  if (error) console.error('[CloudStorage] update failed:', error.message);
}

export async function cloudClearAll(): Promise<void> {
  const { error } = await supabase.from('portfolios').delete().neq('ticker', '');
  if (error) console.error('[CloudStorage] clear failed:', error.message);
}

export async function cloudImportStocksWithPositions(
  stocks: Array<{ ticker: string; name?: string; shares?: number; avgCost?: number }>
): Promise<{ added: string[]; updated: string[]; skipped: string[] }> {
  const existing = await getCloudPortfolio();
  const existingMap = new Map(existing.map(s => [s.ticker, s]));
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const stock of stocks) {
    const normalized = stock.ticker.trim().toUpperCase();
    if (!normalized) { skipped.push(stock.ticker || 'empty'); continue; }

    if (existingMap.has(normalized)) {
      const patch: Record<string, unknown> = {};
      if (stock.name) patch.name = stock.name;
      if (stock.shares !== undefined) patch.shares = stock.shares;
      if (stock.avgCost !== undefined) patch.avg_cost = stock.avgCost;
      if (Object.keys(patch).length > 0) {
        await supabase.from('portfolios').update(patch).eq('ticker', normalized);
      }
      updated.push(normalized);
    } else {
      await supabase.from('portfolios').insert({
        ticker: normalized,
        name: stock.name || normalized,
        shares: stock.shares ?? null,
        avg_cost: stock.avgCost ?? null,
      });
      added.push(normalized);
    }
  }

  return { added, updated, skipped };
}
