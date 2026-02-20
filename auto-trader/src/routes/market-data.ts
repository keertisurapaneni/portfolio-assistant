/**
 * GET /api/sector/:symbol   — company sector (Finnhub company profile)
 * GET /api/earnings/:symbol — next earnings date (Finnhub earnings calendar)
 * GET /api/regime/spy       — SPY vs SMA200 for macro regime (block Gold Mine when below)
 *
 * Used by the smart trading system for sector concentration limits,
 * earnings blackout checks, and macro regime differentiation.
 */

import { Router } from 'express';

const router = Router();

// ── SPY vs SMA200 (macro regime) ──
const REGIME_CACHE_MS = 15 * 60 * 1000; // 15 min
let _spyRegimeCache: { price: number; sma200: number; belowSma200: boolean; ts: number } | null = null;

async function fetchSpyRegime(): Promise<{ price: number; sma200: number; belowSma200: boolean } | null> {
  if (_spyRegimeCache && Date.now() - _spyRegimeCache.ts < REGIME_CACHE_MS) {
    return _spyRegimeCache;
  }
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d&includePrePost=false';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    if (closes.length < 200) return null;
    const price = closes[closes.length - 1];
    const sma200 = closes.slice(-200).reduce((a: number, b: number) => a + b, 0) / 200;
    const belowSma200 = price < sma200;
    _spyRegimeCache = { price, sma200, belowSma200, ts: Date.now() };
    return _spyRegimeCache;
  } catch {
    return null;
  }
}

router.get('/regime/spy', async (_req, res) => {
  try {
    const regime = await fetchSpyRegime();
    if (!regime) {
      return res.json({ price: null, sma200: null, belowSma200: null, error: 'Could not fetch SPY data' });
    }
    res.json({
      price: regime.price,
      sma200: regime.sma200,
      belowSma200: regime.belowSma200,
    });
  } catch (err) {
    console.error('[Route: regime/spy]:', err);
    res.status(500).json({ error: 'Failed to fetch SPY regime' });
  }
});

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';

// ── Sector lookup via Finnhub company profile ──

router.get('/sector/:symbol', async (req, res) => {
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

  try {
    const url = `${FINNHUB_BASE}/stock/profile2?symbol=${symbol}&token=${FINNHUB_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).json({ error: `Could not fetch profile for ${symbol}` });
    }
    const data = await response.json() as {
      finnhubIndustry?: string;
      name?: string;
      ticker?: string;
    };

    res.json({
      symbol,
      sector: data.finnhubIndustry ?? null,
      finnhubIndustry: data.finnhubIndustry ?? null,
      companyName: data.name ?? null,
    });
  } catch (err) {
    console.error(`[Route: sector] ${symbol}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// ── Earnings calendar lookup via Finnhub ──

router.get('/earnings/:symbol', async (req, res) => {
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

  try {
    // Search for next earnings within 30 days
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `${FINNHUB_BASE}/calendar/earnings?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.json({ symbol, earningsDate: null });
    }
    const data = await response.json() as {
      earningsCalendar?: Array<{ date?: string; symbol?: string }>;
    };

    const calendar = data.earningsCalendar ?? [];
    const nextEarnings = calendar.find(e => e.symbol === symbol);

    res.json({
      symbol,
      earningsDate: nextEarnings?.date ?? null,
    });
  } catch (err) {
    console.error(`[Route: earnings] ${symbol}:`, err);
    res.json({ symbol, earningsDate: null }); // fail open
  }
});

export default router;
