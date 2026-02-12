/**
 * GET /api/contract/:symbol — resolve ticker to IB contract
 */

import { Router } from 'express';
import { searchContract } from '../ib-connection.js';

const router = Router();

router.get('/contract/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    const result = await searchContract(symbol.toUpperCase());

    if (!result) {
      return res.status(404).json({ error: `Contract not found for ${symbol}` });
    }

    // Return in the shape the web app expects (IBContractSearch)
    res.json({
      conid: result.conId,
      companyHeader: result.description,
      companyName: result.description,
      symbol: result.symbol,
      secType: result.secType,
      exchange: result.primaryExch,
    });
  } catch (err) {
    console.error('[Route: contract]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
