import { Router } from 'express';
import { findBestContractForStrike } from '../lib/options-chain.js';
import { fetchQuote } from '../lib/yahoo-finance.js';
import { getFundamentalGrade } from '../lib/fundamental-grader.js';
import { isConnected, placeOptionsOrder, getDefaultAccount, getPaperConnection } from '../ib-connection.js';
import { getSupabase, createAutoTradeEvent } from '../lib/supabase.js';

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

/**
 * POST /api/options/place-order
 * Place an IB order for an existing paper trade that was recorded without one (paper fallback).
 * Body: { tradeId }
 */
router.post('/options/place-order', async (req, res) => {
  try {
    const { tradeId } = req.body;
    if (!tradeId) {
      return res.status(400).json({ error: 'tradeId is required' });
    }

    if (!isConnected()) {
      return res.status(503).json({ error: 'IB Gateway not connected' });
    }

    const sb = getSupabase();
    const { data: trade, error } = await sb
      .from('paper_trades')
      .select('id, ticker, mode, option_strike, option_expiry, option_premium, ib_order_id, status')
      .eq('id', tradeId)
      .single();

    if (error || !trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    if (trade.ib_order_id) {
      return res.status(400).json({ error: `Trade already has IB order #${trade.ib_order_id}` });
    }

    const right = trade.mode === 'OPTIONS_CALL' ? 'C' : 'P';
    let expiry = trade.option_expiry.replace(/-/g, '');

    // Allow overriding limit price via request body (premium may have changed)
    const limitPrice = req.body.limitPrice ?? trade.option_premium;

    // Resolve correct IB expiry — try the stored date, then ±1 day (IB can use
    // settlement date vs last trade date which differs by a day for monthlies)
    const conn = getPaperConnection();
    let resolvedExpiry: string | null = null;
    for (const offset of [0, 1, -1, 2]) {
      const d = new Date(
        parseInt(expiry.slice(0, 4)),
        parseInt(expiry.slice(4, 6)) - 1,
        parseInt(expiry.slice(6, 8)) + offset,
      );
      const candidate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const conId = await conn.resolveOptionConId(trade.ticker, right, trade.option_strike, candidate);
      if (conId) {
        resolvedExpiry = candidate;
        break;
      }
    }
    if (resolvedExpiry) expiry = resolvedExpiry;

    const { orderId, avgFillPrice, filledQty } = await placeOptionsOrder({
      symbol: trade.ticker,
      right,
      strike: trade.option_strike,
      expiry,
      contracts: 1,
      limitPrice,
      account: getDefaultAccount() ?? undefined,
    });

    await sb.from('paper_trades').update({
      ib_order_id: orderId,
      fill_price: avgFillPrice,
      status: 'FILLED',
      filled_at: new Date().toISOString(),
    }).eq('id', tradeId);

    createAutoTradeEvent({
      ticker: trade.ticker,
      event_type: 'success',
      action: 'executed',
      source: 'scanner',
      mode: trade.mode,
      message: `IB order filled #${orderId} — Sold ${filledQty}x $${trade.option_strike}${right} exp ${trade.option_expiry} @ $${avgFillPrice.toFixed(2)}/contract (manual placement)`,
      metadata: { ibOrderId: orderId, strike: trade.option_strike, expiry: trade.option_expiry, premium: avgFillPrice, contracts: filledQty },
    }).catch(() => {});

    res.json({
      success: true,
      orderId,
      avgFillPrice,
      filledQty,
      ticker: trade.ticker,
      strike: trade.option_strike,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Route: options/place-order]', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

export default router;
