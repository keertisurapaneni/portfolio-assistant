/**
 * GET /api/sector/:symbol   — company sector (Finnhub company profile)
 * GET /api/earnings/:symbol — next earnings date (Finnhub earnings calendar)
 *
 * Used by the smart trading system for sector concentration limits
 * and earnings blackout checks.
 */

import { Router } from 'express';

const router = Router();

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
