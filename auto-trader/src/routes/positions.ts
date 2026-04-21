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

/** In-memory price cache: symbol → { price, fetchedAt } */
const priceCache = new Map<string, { price: number | null; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60_000; // 5-minute TTL — re-fetch at most once per 5 minutes

/** Fetch current price for a ticker from Finnhub. Returns null on failure. */
async function getQuotePrice(symbol: string): Promise<number | null> {
  if (!FINNHUB_KEY) return null;

  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    const res = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${symbol.toUpperCase()}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json() as { c?: number };
    const price = data.c && data.c > 0 ? data.c : null;
    priceCache.set(symbol, { price, fetchedAt: Date.now() });
    return price;
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Fetch prices for a list of symbols sequentially with a small delay between each.
 * Firing all requests in parallel against Finnhub's 60 req/min free tier causes
 * rate-limit failures that silently return null → 0, making portfolio stats wrong.
 * Sequential with 60ms gaps = ~16 req/s, comfortably under the limit.
 * De-duplication ensures each unique symbol is only fetched once.
 */
async function getQuotePricesStaggered(symbols: string[]): Promise<(number | null)[]> {
  const uniqueSymbols = [...new Set(symbols)];
  const priceMap = new Map<string, number | null>();

  for (let i = 0; i < uniqueSymbols.length; i++) {
    const symbol = uniqueSymbols[i]!;
    priceMap.set(symbol, await getQuotePrice(symbol));
    if (i < uniqueSymbols.length - 1) {
      await delay(250); // 250ms ≈ 4 req/s — leaves headroom for the scanner's concurrent Finnhub calls
    }
  }

  return symbols.map(s => priceMap.get(s) ?? null);
}

router.get('/positions', async (_req, res) => {
  try {
    const positions = await requestPositions();
    const openPositions = positions.filter(p => p.position !== 0);

    // Fetch current prices sequentially to avoid Finnhub rate-limit failures
    // (Promise.all with 36 parallel requests causes silent null returns)
    const symbols = openPositions.map(p => p.symbol);
    const prices = await getQuotePricesStaggered(symbols);

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

/**
 * Pre-warm the position price cache for a list of symbols.
 * Called by the scheduler after each scan cycle so page loads are instant.
 */
export async function warmPositionPriceCache(symbols: string[]): Promise<void> {
  try {
    await getQuotePricesStaggered(symbols);
    console.log(`[Positions] Price cache warmed for ${symbols.length} symbols`);
  } catch (err) {
    console.warn('[Positions] Cache warm failed:', err);
  }
}

export default router;
