import { Router } from 'express';
import { findBestContractForStrike } from '../lib/options-chain.js';
import { fetchQuote } from '../lib/yahoo-finance.js';
import { getFundamentalGrade } from '../lib/fundamental-grader.js';

const router = Router();

router.get('/options/strike-sniper', async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? '').toUpperCase().trim();
    const targetStrike = Number(req.query.targetStrike);
    const minReturn = Number(req.query.minReturn || 8);

    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (!Number.isFinite(targetStrike) || targetStrike <= 0) {
      return res.status(400).json({ error: 'targetStrike must be a positive number' });
    }

    const quote = await fetchQuote(symbol);
    const currentPrice = quote?.price ?? null;

    if (currentPrice && targetStrike < currentPrice * 0.40) {
      return res.status(400).json({
        error: `Target strike $${targetStrike} is too far below ${symbol}'s current price ($${currentPrice.toFixed(0)}). Try a strike within 10-30% below the current price.`,
      });
    }

    const contracts = await findBestContractForStrike(symbol, targetStrike, minReturn, currentPrice ?? undefined);
    const fundamental = await getFundamentalGrade(symbol);

    res.json({
      symbol,
      currentPrice,
      targetStrike,
      fundamental: { grade: fundamental.grade, score: fundamental.score },
      contracts,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Strike sniper failed' });
  }
});

export default router;
