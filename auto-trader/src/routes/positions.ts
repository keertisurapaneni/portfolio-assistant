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

    // Map to IBPosition shape the web app expects, now with real market data
    res.json(
      openPositions.map((p, i) => {
        const mktPrice = prices[i] ?? 0;
        const absPosition = Math.abs(p.position);
        const mktValue = absPosition * mktPrice;
        const costBasis = absPosition * p.avgCost;
        // For long positions: unrealized = mktValue - costBasis
        // For short positions: unrealized = costBasis - mktValue (profit when price drops)
        const unrealizedPnl = p.position > 0
          ? mktValue - costBasis
          : costBasis - mktValue;

        return {
          acctId: p.account,
          conid: p.conId,
          contractDesc: p.symbol,
          position: p.position,
          mktPrice,
          mktValue,
          avgCost: p.avgCost,
          avgPrice: p.avgCost,
          realizedPnl: 0,    // would need execution tracking
          unrealizedPnl: mktPrice > 0 ? unrealizedPnl : 0,
          currency: 'USD',
        };
      })
    );
  } catch (err) {
    console.error('[Route: positions]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
