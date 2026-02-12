/**
 * GET /api/positions — all open positions with P&L
 */

import { Router } from 'express';
import { requestPositions } from '../ib-connection.js';

const router = Router();

router.get('/positions', async (_req, res) => {
  try {
    const positions = await requestPositions();

    // Map to IBPosition shape the web app expects
    res.json(
      positions
        .filter(p => p.position !== 0) // only open positions
        .map(p => ({
          acctId: p.account,
          conid: p.conId,
          contractDesc: p.symbol,
          position: p.position,
          mktPrice: 0,      // would need market data subscription
          mktValue: 0,
          avgCost: p.avgCost,
          avgPrice: p.avgCost,
          realizedPnl: 0,
          unrealizedPnl: 0,
          currency: 'USD',
        }))
    );
  } catch (err) {
    console.error('[Route: positions]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
