/**
 * POST /api/order      — place a bracket order
 * DELETE /api/order/:id — cancel an order
 */

import { Router } from 'express';
import {
  placeBracketOrder,
  placeMarketOrder,
  cancelOrder,
  requestOpenOrders,
  type BracketOrderParams,
} from '../ib-connection.js';

const router = Router();

/**
 * POST /api/order
 * Body: { symbol, side, quantity, entryPrice, stopLoss, takeProfit, tif? }
 */
router.post('/order', async (req, res) => {
  try {
    const { symbol, side, quantity, entryPrice, stopLoss, takeProfit, tif } = req.body as BracketOrderParams;

    if (!symbol || !side || !quantity || !entryPrice || !stopLoss || !takeProfit) {
      return res.status(400).json({
        error: 'Missing required fields: symbol, side, quantity, entryPrice, stopLoss, takeProfit',
      });
    }

    if (!['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ error: 'side must be BUY or SELL' });
    }

    const result = await placeBracketOrder({
      symbol,
      side,
      quantity: Number(quantity),
      entryPrice: Number(entryPrice),
      stopLoss: Number(stopLoss),
      takeProfit: Number(takeProfit),
      tif: tif ?? 'GTC',
    });

    // Return in the shape the web app expects (IBOrderReply[])
    res.json([
      {
        order_id: String(result.parentOrderId),
        order_status: 'Submitted',
        parent_order_id: String(result.parentOrderId),
        tp_order_id: String(result.takeProfitOrderId),
        sl_order_id: String(result.stopLossOrderId),
      },
    ]);
  } catch (err) {
    console.error('[Route: order]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /api/market-order
 * Body: { symbol, side, quantity }
 * Simple market order — no bracket, no stop loss, no target.
 * Used for long-term holds (Suggested Finds).
 */
router.post('/market-order', async (req, res) => {
  try {
    const { symbol, side, quantity } = req.body;

    if (!symbol || !side || !quantity) {
      return res.status(400).json({
        error: 'Missing required fields: symbol, side, quantity',
      });
    }

    if (!['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ error: 'side must be BUY or SELL' });
    }

    const result = await placeMarketOrder({
      symbol,
      side,
      quantity: Number(quantity),
    });

    res.json([
      {
        order_id: String(result.orderId),
        order_status: 'Submitted',
      },
    ]);
  } catch (err) {
    console.error('[Route: market-order]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /api/orders — list all open orders
 */
router.get('/orders', async (_req, res) => {
  try {
    const orders = await requestOpenOrders();
    // Map to IBLiveOrder shape
    res.json({
      orders: orders.map(o => ({
        orderId: o.orderId,
        conid: 0,
        ticker: o.symbol,
        side: o.action,
        orderType: o.orderType,
        price: o.lmtPrice || o.auxPrice,
        quantity: o.totalQuantity,
        filledQuantity: 0,
        status: o.status,
        parentId: o.parentId,
      })),
    });
  } catch (err) {
    console.error('[Route: orders]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * DELETE /api/order/:id — cancel an order
 */
router.delete('/order/:id', (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    cancelOrder(orderId);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error('[Route: cancel order]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
