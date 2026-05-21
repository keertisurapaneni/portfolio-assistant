import { Router } from 'express';
import { findBestContractForStrike, getOptionsChain } from '../lib/options-chain.js';
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
/** Returns true if current time is within regular US equity market hours (9:30–16:00 ET, Mon–Fri). */
function isMarketOpen(): boolean {
  const now = new Date();
  const etOffset = -4; // EDT (May–Nov); adjust to -5 for EST if needed
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin = now.getUTCMinutes();
  const etDay = new Date(now.getTime() + etOffset * 3600_000).getUTCDay(); // 0=Sun,6=Sat
  if (etDay === 0 || etDay === 6) return false;
  const etMins = etHour * 60 + etMin;
  return etMins >= 9 * 60 + 30 && etMins < 16 * 60;
}

router.post('/options/place-order', async (req, res) => {
  try {
    const { tradeId } = req.body;
    if (!tradeId) {
      return res.status(400).json({ error: 'tradeId is required' });
    }

    if (!isConnected()) {
      return res.status(503).json({ error: 'IB Gateway not connected' });
    }

    if (!isMarketOpen()) {
      return res.status(503).json({ error: 'Market is closed. Options orders can only be submitted during market hours (9:30 AM – 4:00 PM ET, Mon–Fri).' });
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
    let limitPrice: number = req.body.limitPrice ?? trade.option_premium;
    let resolvedStrike: number = trade.option_strike;
    let resolvedConId: number | undefined;

    // ── Step 1: Try to resolve the exact stored contract (strike + expiry) ──
    // resolveOptionConId retries ±1/2 day expiry offsets internally and returns
    // BOTH the conId and the expiry date that actually matched. We must use the
    // resolvedExpiry (not the stored date) in the order, otherwise IB rejects with
    // code=200 "No security definition" when the stored date is off by one day.
    // We also pass conId so IB routes by contract ID, bypassing tradingClass
    // mismatches (e.g. ADI, DOCU, RBRK).
    const conn = getPaperConnection();
    let lastIbError: string | undefined;
    const captureIbError = (err: string) => { lastIbError = err; };

    const exactResult = await conn.resolveOptionConId(trade.ticker, right, trade.option_strike, expiry, captureIbError);

    if (exactResult) {
      expiry = exactResult.resolvedExpiry;
      resolvedConId = exactResult.conId;
      if (expiry !== trade.option_expiry.replace(/-/g, '')) {
        console.log(`[place-order] Expiry offset applied: ${trade.ticker} $${trade.option_strike}${right} stored=${trade.option_expiry} → IB resolved=${expiry}`);
      }
      console.log(`[place-order] Contract resolved for ${trade.ticker} $${trade.option_strike}${right} conId=${exactResult.conId} exp=${expiry} — placing order`);
    } else {
      // ── Step 2: Exact strike not in IB (came from synthetic pricing) ──
      // Fetch IB's real options chain and find the nearest listed contract.
      console.log(`[place-order] Exact strike $${trade.option_strike}${right} not in IB — fetching live chain for ${trade.ticker}`);

      const quote = await fetchQuote(trade.ticker);
      const currentPrice = quote?.price ?? trade.option_strike * 1.05; // rough fallback

      const chain = await getOptionsChain(trade.ticker, currentPrice, null);
      const bestPut = chain?.bestPut;

      if (!bestPut) {
        return res.status(422).json({
          error: `No options chain available for ${trade.ticker} in IB. Ensure IB Gateway is connected and the ticker has listed options.${lastIbError ? ` (${lastIbError})` : ''}`,
        });
      }

      resolvedStrike = bestPut.strike;
      expiry = bestPut.expiry;
      // Use the live market bid as limit price (conservative fill, same as scanner logic)
      limitPrice = bestPut.bid > 0 ? bestPut.bid : bestPut.mid;

      // Verify the chain-snapped contract is a real IB-listed option, not synthetic
      // Black-Scholes data. getOptionsChain() falls back to B-S when IB can't provide
      // real chain data (e.g. no options listed, no market data subscription). B-S uses
      // $2.5 strike increments but IB may only list $5 increments (e.g. VIK $72.5 →
      // real strikes are $70/$75). When the exact strike fails, search nearby standard
      // increments so we can always find the real IB-listed contract closest to target.
      let chainConResult: { conId: number; resolvedExpiry: string } | null = null;

      // Build candidate strikes: exact first, then floor/ceil at $5 and $2.5 increments
      const candidateStrikes = new Set<number>([resolvedStrike]);
      for (const inc of [5, 2.5]) {
        candidateStrikes.add(Math.round(Math.floor(resolvedStrike / inc) * inc * 100) / 100);
        candidateStrikes.add(Math.round(Math.ceil(resolvedStrike / inc) * inc * 100) / 100);
      }
      // Sort by distance from the original target strike, ascending
      const sortedStrikes = [...candidateStrikes].sort(
        (a, b) => Math.abs(a - resolvedStrike) - Math.abs(b - resolvedStrike)
      );

      for (const candidateStrike of sortedStrikes) {
        chainConResult = await conn.resolveOptionConId(trade.ticker, right, candidateStrike, expiry, captureIbError);
        if (chainConResult) {
          if (candidateStrike !== resolvedStrike) {
            console.log(`[place-order] Strike snapped: ${trade.ticker} synthetic $${resolvedStrike} → IB-listed $${candidateStrike} (nearest real strike)`);
          }
          resolvedStrike = candidateStrike;
          break;
        }
      }

      if (!chainConResult) {
        return res.status(422).json({
          error: `${trade.ticker} options could not be verified in IB near $${bestPut.strike}${right} exp ${expiry} — tried strikes ${sortedStrikes.join(', ')}.${lastIbError ? ` (${lastIbError})` : ''}`,
        });
      }
      // Override expiry with the one that actually resolved (may differ by ±1 day)
      expiry = chainConResult.resolvedExpiry;
      resolvedConId = chainConResult.conId;

      console.log(`[place-order] Snapped to nearest IB contract: ${trade.ticker} $${resolvedStrike}${right} exp ${expiry} @ $${limitPrice.toFixed(2)} conId=${chainConResult.conId}`);

      // Update the paper_trade to reflect the IB-corrected contract details so
      // the UI shows the real position, not the synthetic one.
      await sb.from('paper_trades').update({
        option_strike: resolvedStrike,
        option_expiry: `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`,
        option_premium: limitPrice,
        option_net_price: resolvedStrike - limitPrice,
        pnl: null, // will be set by trigger when fill arrives
      }).eq('id', tradeId);
    }
    const { orderId, avgFillPrice, filledQty, timedOut } = await placeOptionsOrder({
      symbol: trade.ticker,
      right,
      strike: resolvedStrike,
      expiry,
      contracts: 1,
      limitPrice,
      conId: resolvedConId,
      account: getDefaultAccount() ?? undefined,
    });

    const snappedNote = resolvedStrike !== trade.option_strike ? `, snapped from synthetic $${trade.option_strike}` : '';

    if (timedOut) {
      // Order is live in IB as a pending DAY LMT — awaiting fill. Record as SUBMITTED.
      await sb.from('paper_trades').update({
        ib_order_id: orderId,
        status: 'SUBMITTED',
      }).eq('id', tradeId);

      createAutoTradeEvent({
        ticker: trade.ticker,
        event_type: 'success',
        action: 'executed',
        source: 'scanner',
        mode: trade.mode,
        message: `Order submitted to IB #${orderId} — $${resolvedStrike}${right} exp ${expiry} @ $${limitPrice.toFixed(2)} limit (manual placement${snappedNote}) — awaiting fill`,
        metadata: { ibOrderId: orderId, strike: resolvedStrike, expiry, limitPrice, contracts: 1 },
      }).catch(() => {});
    } else {
      // Immediate fill — record actual fill price.
      await sb.from('paper_trades').update({
        ib_order_id: orderId,
        fill_price: avgFillPrice,
        option_premium: avgFillPrice,
        status: 'FILLED',
        filled_at: new Date().toISOString(),
      }).eq('id', tradeId);

      createAutoTradeEvent({
        ticker: trade.ticker,
        event_type: 'success',
        action: 'executed',
        source: 'scanner',
        mode: trade.mode,
        message: `IB order filled #${orderId} — Sold ${filledQty}x $${resolvedStrike}${right} exp ${expiry} @ $${avgFillPrice.toFixed(2)}/contract (manual placement${snappedNote})`,
        metadata: { ibOrderId: orderId, strike: resolvedStrike, expiry, premium: avgFillPrice, contracts: filledQty },
      }).catch(() => {});
    }

    res.json({
      success: true,
      orderId,
      avgFillPrice,
      filledQty,
      ticker: trade.ticker,
      strike: resolvedStrike,
      originalStrike: trade.option_strike,
      snapped: resolvedStrike !== trade.option_strike,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Route: options/place-order]', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/options/discard
 * Discard a paper-only options trade that was never submitted to IB.
 * Only allowed if the trade has no ib_order_id (i.e., hasn't been submitted).
 * Body: { tradeId }
 */
router.post('/options/discard', async (req, res) => {
  try {
    const { tradeId } = req.body;
    if (!tradeId) {
      return res.status(400).json({ error: 'tradeId is required' });
    }

    const sb = getSupabase();
    const { data: trade, error } = await sb
      .from('paper_trades')
      .select('id, ticker, mode, option_strike, option_expiry, ib_order_id, status')
      .eq('id', tradeId)
      .single();

    if (error || !trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    if (trade.ib_order_id) {
      return res.status(400).json({ error: 'Cannot discard a trade that has already been submitted to IB' });
    }

    const { error: updateError } = await sb
      .from('paper_trades')
      .update({
        status: 'CANCELLED',
        close_reason: 'discarded',
        closed_at: new Date().toISOString(),
        notes: `[DISCARDED] Paper-only trade removed manually — never submitted to IB`,
      })
      .eq('id', tradeId);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    createAutoTradeEvent({
      ticker: trade.ticker,
      event_type: 'info',
      action: 'skipped',
      source: 'scanner',
      mode: trade.mode,
      message: `🗑 ${trade.ticker} $${trade.option_strike}P exp ${trade.option_expiry} discarded — paper-only trade removed without submitting to IB`,
      metadata: { tradeId, reason: 'manual_discard' },
    }).catch(() => {});

    res.json({ success: true, tradeId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Route: options/discard]', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

export default router;
