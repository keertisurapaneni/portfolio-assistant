/**
 * GET /api/positions — all open positions with real-time P&L
 *
 * Enriches IB position data (shares, avgCost) with current market prices
 * from Finnhub to calculate mktPrice, mktValue, and unrealizedPnl.
 */

import { Router } from 'express';
import { requestPositions } from '../ib-connection.js';

const router = Router();

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';

/** Fetch current price for a ticker from Finnhub. Returns null on failure. */
async function getQuotePrice(symbol: string): Promise<number | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${symbol.toUpperCase()}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json() as { c?: number };
    return data.c && data.c > 0 ? data.c : null;
  } catch {
    return null;
  }
}

router.get('/positions', async (_req, res) => {
  try {
    const positions = await requestPositions();
    const openPositions = positions.filter(p => p.position !== 0);

    // Fetch current prices in parallel for all positions
    const symbols = openPositions.map(p => p.symbol);
    const pricePromises = symbols.map(s => getQuotePrice(s));
    const prices = await Promise.all(pricePromises);

    // Map to IBPosition shape the web app expects, now with real market data.
    // Options (secType === 'OPT') are flagged separately: avgCost from IB is the per-contract
    // premium (premium × 100 multiplier), so using the underlying stock price to compute
    // mktValue would produce completely wrong numbers. We mark them as unpriced so the
    // frontend can exclude them from portfolio-level stats (they're tracked in the Options tab).
    res.json(
      openPositions.map((p, i) => {
        const isOption = p.secType === 'OPT';
        const mktPrice = isOption ? 0 : (prices[i] ?? 0);
        const absPosition = Math.abs(p.position);

        // For options: show avgCost as-is (premium per contract) but mark mktValue = 0
        // so the frontend can distinguish "option we can't price here" vs "stock we couldn't
        // get a quote for" using the secType field.
        const mktValue = isOption ? 0 : absPosition * mktPrice;
        const costBasis = absPosition * p.avgCost;
        const unrealizedPnl = (!isOption && mktPrice > 0)
          ? (p.position > 0 ? mktValue - costBasis : costBasis - mktValue)
          : 0;

        return {
          acctId: p.account,
          conid: p.conId,
          contractDesc: p.symbol,
          secType: p.secType,   // "STK" | "OPT" | "FUT" etc — used by frontend to filter stats
          position: p.position,
          mktPrice,
          mktValue,
          avgCost: p.avgCost,
          avgPrice: p.avgCost,
          realizedPnl: 0,       // would need execution tracking to populate
          unrealizedPnl,
          currency: 'USD',
        };
      })
    );
  } catch (err) {
    console.error('[Route: positions]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// ── GET /api/quote/:symbol — lightweight price lookup for position sizing ──
router.get('/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const price = await getQuotePrice(symbol);
  if (price === null) {
    return res.status(404).json({ error: `Could not fetch price for ${symbol}` });
  }

  res.json({ symbol, price });
});

export default router;
