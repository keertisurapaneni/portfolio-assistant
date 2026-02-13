/**
 * Auto-Trader — orchestrates the full flow:
 *   Scanner idea → Full Analysis → Risk check → IB bracket order → Log trade
 *   Suggested Finds → Market buy (long-term hold, no FA needed) → Log trade
 *
 * Runs entirely in the browser. No backend polling needed.
 */

import type { TradeIdea } from './tradeScannerApi';
import type { EnhancedSuggestedStock } from '../data/suggestedFinds';
import type { TradingSignalsResponse, SignalsMode } from './tradingSignalsApi';
import { fetchTradingSignal } from './tradingSignalsApi';
import {
  checkAuthStatus,
  pingSession,
  searchContract,
  placeBracketOrder,
  placeMarketOrder,
  getPositions,
  confirmOrder,
  type IBOrderReply,
} from './ibClient';
import {
  createPaperTrade,
  updatePaperTrade,
  hasActiveTrade,
  countActivePositions,
  getActiveTrades,
  createAutoTradeEvent,
  type PaperTrade,
} from './paperTradesApi';
import { analyzeCompletedTrade, updatePerformancePatterns } from './aiFeedback';

// ── Lightweight price lookup (via auto-trader service — Finnhub key stays server-side) ──
const _IB_BASE = 'http://localhost:3001/api';

/** Get the current market price for a ticker (for position sizing). Returns null on failure. */
async function getQuotePrice(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(`${_IB_BASE}/quote/${ticker.toUpperCase()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.price > 0 ? data.price : null;
  } catch {
    return null;
  }
}

// ── Configuration ────────────────────────────────────────

export interface AutoTraderConfig {
  enabled: boolean;
  maxPositions: number;          // max concurrent positions
  positionSize: number;          // $ per position (paper money)
  minScannerConfidence: number;  // min scanner confidence to consider
  minFAConfidence: number;       // min FA confidence to execute
  minSuggestedFindsConviction: number; // min conviction for Suggested Finds auto-buy
  accountId: string | null;      // IB paper account ID
  dayTradeAutoClose: boolean;    // auto-close day trades at 3:55 PM ET
}

const CONFIG_KEY = 'auto-trader-config';

const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  maxPositions: 3,
  positionSize: 1000,
  minScannerConfidence: 7,
  minFAConfidence: 7,
  minSuggestedFindsConviction: 8,
  accountId: null,
  dayTradeAutoClose: true,
};

export function getAutoTraderConfig(): AutoTraderConfig {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

export function saveAutoTraderConfig(config: Partial<AutoTraderConfig>): AutoTraderConfig {
  const current = getAutoTraderConfig();
  const updated = { ...current, ...config };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(updated));
  return updated;
}

// ── Auto-Trade Execution Log ─────────────────────────────

export interface AutoTradeEvent {
  timestamp: number;
  ticker: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

let _eventLog: AutoTradeEvent[] = [];
let _eventListeners: Array<(events: AutoTradeEvent[]) => void> = [];

function logEvent(ticker: string, type: AutoTradeEvent['type'], message: string) {
  const event: AutoTradeEvent = { timestamp: Date.now(), ticker, type, message };
  _eventLog = [event, ..._eventLog.slice(0, 99)]; // keep last 100
  _eventListeners.forEach(fn => fn(_eventLog));
  const prefix = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
  console.log(`[AutoTrader] ${prefix} ${ticker}: ${message}`);
}

export function getEventLog(): AutoTradeEvent[] {
  return _eventLog;
}

export function onEventLogChange(fn: (events: AutoTradeEvent[]) => void): () => void {
  _eventListeners.push(fn);
  return () => {
    _eventListeners = _eventListeners.filter(l => l !== fn);
  };
}

// ── Session / Connection State ───────────────────────────

let _ibConnected = false;
let _pingInterval: ReturnType<typeof setInterval> | null = null;
let _connectionListeners: Array<(connected: boolean) => void> = [];

export function isIBConnected(): boolean {
  return _ibConnected;
}

export function onConnectionChange(fn: (connected: boolean) => void): () => void {
  _connectionListeners.push(fn);
  return () => {
    _connectionListeners = _connectionListeners.filter(l => l !== fn);
  };
}

function setConnected(connected: boolean) {
  if (_ibConnected !== connected) {
    _ibConnected = connected;
    _connectionListeners.forEach(fn => fn(connected));
  }
}

/** Start pinging auto-trader service to keep connection status updated */
export function startSessionPing() {
  stopSessionPing();
  _pingInterval = setInterval(async () => {
    try {
      const status = await checkAuthStatus();
      setConnected(status.authenticated && status.connected);
    } catch {
      setConnected(false);
    }
  }, 60_000); // every 60s

  // Immediate check
  checkAuthStatus()
    .then(s => setConnected(s.authenticated && s.connected))
    .catch(() => setConnected(false));
}

export function stopSessionPing() {
  if (_pingInterval) {
    clearInterval(_pingInterval);
    _pingInterval = null;
  }
}

// ── Day Trade Auto-Close ─────────────────────────────────

let _autoCloseTimeout: ReturnType<typeof setTimeout> | null = null;

/** Schedule auto-close for day trades at 3:55 PM ET */
export function scheduleDayTradeAutoClose(config: AutoTraderConfig) {
  if (_autoCloseTimeout) clearTimeout(_autoCloseTimeout);
  if (!config.dayTradeAutoClose || !config.accountId) return;

  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const closeHour = 15; // 3 PM
  const closeMin = 55;  // 3:55 PM

  const closeTime = new Date(et);
  closeTime.setHours(closeHour, closeMin, 0, 0);

  if (et > closeTime) return; // already past close time today

  const msUntilClose = closeTime.getTime() - et.getTime();
  logEvent('*', 'info', `Day trade auto-close scheduled in ${Math.round(msUntilClose / 60000)} minutes`);

  _autoCloseTimeout = setTimeout(async () => {
    logEvent('*', 'info', 'Closing all day trade positions (3:55 PM ET)...');
    await closeAllDayTrades(config.accountId!);
  }, msUntilClose);
}

/** Close all open day trade positions */
async function closeAllDayTrades(accountId: string) {
  try {
    const activeTrades = await getActiveTrades();
    const dayTrades = activeTrades.filter(t => t.mode === 'DAY_TRADE' && t.status === 'FILLED');

    for (const trade of dayTrades) {
      try {
        const contract = await searchContract(trade.ticker);
        if (!contract) {
          logEvent(trade.ticker, 'error', 'Cannot find contract for EOD close');
          continue;
        }

        const closeSide = trade.signal === 'BUY' ? 'SELL' : 'BUY';
        const result = await placeMarketOrder({
          accountId,
          conid: contract.conid,
          symbol: trade.ticker,
          side: closeSide as 'BUY' | 'SELL',
          quantity: trade.quantity ?? 0,
        });

        // Handle confirmation if needed
        await handleOrderConfirmations(result);

        await updatePaperTrade(trade.id, {
          status: 'CLOSED',
          close_reason: 'eod_close',
          closed_at: new Date().toISOString(),
        });

        logEvent(trade.ticker, 'success', 'Day trade closed at EOD');
      } catch (err) {
        logEvent(trade.ticker, 'error', `EOD close failed: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }
  } catch (err) {
    logEvent('*', 'error', `EOD close sweep failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}

// ── Order Confirmation Helper ────────────────────────────

async function handleOrderConfirmations(replies: IBOrderReply[]): Promise<IBOrderReply[]> {
  let finalReplies = replies;

  // IB may return confirmation prompts that need to be accepted
  for (const reply of finalReplies) {
    if (reply.encrypt_message || reply.order_status === 'PreSubmitted') {
      try {
        const confirmed = await confirmOrder(reply.order_id);
        finalReplies = confirmed;
      } catch {
        // Confirmation may not be needed for paper
      }
    }
  }

  return finalReplies;
}

// ── Core: Process Trade Ideas ────────────────────────────

export interface ProcessResult {
  ticker: string;
  action: 'executed' | 'skipped' | 'failed';
  reason: string;
  trade?: PaperTrade;
}

/**
 * Process a batch of scanner trade ideas:
 * 1. Run full analysis on each
 * 2. Apply risk checks
 * 3. Place bracket orders on IB
 * 4. Log to paper_trades table
 */
export async function processTradeIdeas(
  ideas: TradeIdea[],
  config?: AutoTraderConfig
): Promise<ProcessResult[]> {
  const cfg = config ?? getAutoTraderConfig();
  const results: ProcessResult[] = [];

  if (!cfg.enabled) {
    logEvent('*', 'warning', 'Auto-trading is disabled');
    return [];
  }

  if (!cfg.accountId) {
    logEvent('*', 'error', 'No IB account configured');
    return [];
  }

  // Check IB connection
  const authStatus = await checkAuthStatus();
  if (!authStatus.authenticated || !authStatus.connected) {
    logEvent('*', 'error', 'IB Gateway not connected — start auto-trader service');
    return [];
  }

  // Keep session alive
  await pingSession();

  // Check position limits
  const activeCount = await countActivePositions();
  const slotsAvailable = cfg.maxPositions - activeCount;

  if (slotsAvailable <= 0) {
    logEvent('*', 'warning', `Max positions reached (${cfg.maxPositions}). Waiting for slots.`);
    return [];
  }

  // Filter ideas by scanner confidence
  const qualified = ideas.filter(i => i.confidence >= cfg.minScannerConfidence);
  if (qualified.length === 0) {
    logEvent('*', 'info', 'No ideas meet confidence threshold');
    return [];
  }

  // Process ideas up to available slots
  const toProcess = qualified.slice(0, slotsAvailable);

  for (const idea of toProcess) {
    const result = await processSingleIdea(idea, cfg);
    results.push(result);

    // Small delay between orders to avoid rate limits
    if (toProcess.indexOf(idea) < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return results;
}

/** Persist an event to Supabase (fire-and-forget alongside the in-memory log) */
function persistEvent(
  ticker: string,
  eventType: 'info' | 'success' | 'warning' | 'error',
  message: string,
  extra?: {
    action?: 'executed' | 'skipped' | 'failed';
    source?: 'scanner' | 'suggested_finds' | 'manual' | 'system';
    mode?: 'DAY_TRADE' | 'SWING_TRADE';
    scanner_signal?: string;
    scanner_confidence?: number;
    fa_recommendation?: string;
    fa_confidence?: number;
    skip_reason?: string;
    metadata?: Record<string, unknown>;
  }
) {
  createAutoTradeEvent({
    ticker,
    event_type: eventType,
    message,
    ...extra,
  });
}

/** Process a single trade idea end-to-end */
async function processSingleIdea(
  idea: TradeIdea,
  config: AutoTraderConfig
): Promise<ProcessResult> {
  const { ticker, signal, confidence: scannerConf, mode } = idea;

  // ── 1. Dedup check ──
  const alreadyActive = await hasActiveTrade(ticker);
  if (alreadyActive) {
    logEvent(ticker, 'info', 'Already have an active position — skipping');
    persistEvent(ticker, 'info', 'Already have an active position — skipping', {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, skip_reason: 'Duplicate position',
    });
    return { ticker, action: 'skipped', reason: 'Duplicate position' };
  }

  // ── 2. Run Full Analysis ──
  logEvent(ticker, 'info', `Running full analysis (${mode})...`);
  let fa: TradingSignalsResponse;
  try {
    const faMode: SignalsMode = mode === 'DAY_TRADE' ? 'DAY_TRADE' : 'SWING_TRADE';
    fa = await fetchTradingSignal(ticker, faMode);
  } catch (err) {
    const msg = `FA failed: ${err instanceof Error ? err.message : 'Unknown'}`;
    logEvent(ticker, 'error', msg);
    persistEvent(ticker, 'error', msg, {
      action: 'failed', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, skip_reason: 'Full analysis failed',
    });
    return { ticker, action: 'failed', reason: 'Full analysis failed' };
  }

  // ── 3. Confidence Gate ──
  const faConf = fa.trade.confidence;
  const faRec = fa.trade.recommendation;

  if (faConf < config.minFAConfidence) {
    const msg = `FA confidence too low: ${faConf}/10 (need ${config.minFAConfidence}+)`;
    logEvent(ticker, 'info', msg);
    persistEvent(ticker, 'info', msg, {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: `FA confidence ${faConf} < ${config.minFAConfidence}`,
    });
    return { ticker, action: 'skipped', reason: `FA confidence ${faConf} < ${config.minFAConfidence}` };
  }

  if (faRec === 'HOLD') {
    logEvent(ticker, 'info', 'FA says HOLD — skipping');
    persistEvent(ticker, 'info', 'FA says HOLD — skipping', {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: 'FA recommendation is HOLD',
    });
    return { ticker, action: 'skipped', reason: 'FA recommendation is HOLD' };
  }

  // ── 4. Direction Consistency ──
  if (faRec !== signal) {
    const msg = `Scanner says ${signal} but FA says ${faRec} — skipping`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: `Direction mismatch: scanner ${signal} vs FA ${faRec}`,
    });
    return { ticker, action: 'skipped', reason: `Direction mismatch: scanner ${signal} vs FA ${faRec}` };
  }

  // ── 5. Entry/Stop/Target validation ──
  const { entryPrice, stopLoss, targetPrice } = fa.trade;
  if (!entryPrice || !stopLoss || !targetPrice) {
    logEvent(ticker, 'warning', 'FA missing entry/stop/target — skipping');
    persistEvent(ticker, 'warning', 'FA missing entry/stop/target — skipping', {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: 'Missing price levels from FA',
    });
    return { ticker, action: 'skipped', reason: 'Missing price levels from FA' };
  }

  // ── 6. Position Sizing ──
  const quantity = Math.floor(config.positionSize / entryPrice);
  if (quantity < 1) {
    const msg = `Position size too small: $${config.positionSize} / $${entryPrice} < 1 share`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: 'Position size too small for 1 share',
    });
    return { ticker, action: 'skipped', reason: 'Position size too small for 1 share' };
  }

  // ── 7. Search IB Contract ──
  logEvent(ticker, 'info', 'Searching IB contract...');
  const contract = await searchContract(ticker);
  if (!contract) {
    logEvent(ticker, 'error', 'Stock not found on IB');
    persistEvent(ticker, 'error', 'Stock not found on IB', {
      action: 'failed', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: 'IB contract not found',
    });
    return { ticker, action: 'failed', reason: 'IB contract not found' };
  }

  // ── 8. Place Bracket Order ──
  logEvent(ticker, 'info', `Placing bracket order: ${signal} ${quantity} @ $${entryPrice} (SL: $${stopLoss}, TP: $${targetPrice})`);

  try {
    const orderReplies = await placeBracketOrder({
      accountId: config.accountId!,
      conid: contract.conid,
      symbol: ticker,
      side: signal,
      quantity,
      entryPrice,
      stopLoss,
      takeProfit: targetPrice,
      tif: mode === 'DAY_TRADE' ? 'DAY' : 'GTC',
    });

    // Handle any confirmation prompts
    const finalReplies = await handleOrderConfirmations(orderReplies);

    const orderId = finalReplies[0]?.order_id ?? null;

    // ── 9. Log Trade ──
    const trade = await createPaperTrade({
      ticker,
      mode,
      signal,
      scanner_confidence: scannerConf,
      fa_confidence: faConf,
      fa_recommendation: faRec,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      target_price: targetPrice,
      target_price2: fa.trade.targetPrice2,
      risk_reward: fa.trade.riskReward,
      quantity,
      position_size: quantity * entryPrice,
      ib_order_id: orderId,
      status: 'SUBMITTED',
      scanner_reason: idea.reason,
      fa_rationale: fa.trade.rationale,
    });

    const msg = `Order placed! ${signal} ${quantity} shares @ $${entryPrice}`;
    logEvent(ticker, 'success', msg);
    persistEvent(ticker, 'success', msg, {
      action: 'executed', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      metadata: { entry_price: entryPrice, stop_loss: stopLoss, target_price: targetPrice, quantity, risk_reward: fa.trade.riskReward },
    });

    return { ticker, action: 'executed', reason: 'Order placed successfully', trade };
  } catch (err) {
    const msg = `Order failed: ${err instanceof Error ? err.message : 'Unknown'}`;
    logEvent(ticker, 'error', msg);
    persistEvent(ticker, 'error', msg, {
      action: 'failed', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: 'Order rejected by IB',
    });

    // Still log the attempt
    await createPaperTrade({
      ticker,
      mode,
      signal,
      scanner_confidence: scannerConf,
      fa_confidence: faConf,
      fa_recommendation: faRec,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      target_price: targetPrice,
      quantity,
      position_size: quantity * entryPrice,
      status: 'REJECTED',
      notes: `Order rejected: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });

    return { ticker, action: 'failed', reason: `Order rejected: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

// ── Suggested Finds Auto-Buy ─────────────────────────────

/**
 * Process Suggested Finds (Quiet Compounders + Gold Mines) for auto-buying.
 * Auto-buy filter: conviction >= minSuggestedFindsConviction (default 8)
 * AND valuation must be "Undervalued" or "Deep Value".
 * Top picks are always bought regardless of valuation (if conviction meets threshold).
 *
 * These are long-term positions: always SWING_TRADE mode, GTC orders.
 */
export async function processSuggestedFinds(
  stocks: EnhancedSuggestedStock[],
  config?: AutoTraderConfig,
  topPickTickers?: Set<string>
): Promise<ProcessResult[]> {
  const cfg = config ?? getAutoTraderConfig();
  const results: ProcessResult[] = [];

  if (!cfg.enabled) {
    logEvent('*', 'warning', 'Auto-trading is disabled — skipping Suggested Finds');
    return [];
  }

  if (!cfg.accountId) {
    logEvent('*', 'error', 'No IB account configured');
    return [];
  }

  // Check IB connection
  const authStatus = await checkAuthStatus();
  if (!authStatus.authenticated || !authStatus.connected) {
    logEvent('*', 'error', 'IB Gateway not connected');
    return [];
  }

  await pingSession();

  // Check position limits
  const activeCount = await countActivePositions();
  const slotsAvailable = cfg.maxPositions - activeCount;

  if (slotsAvailable <= 0) {
    logEvent('*', 'warning', `Max positions reached (${cfg.maxPositions}). Waiting for slots.`);
    return [];
  }

  // Filter: conviction >= minSuggestedFindsConviction (default 8)
  // AND valuation must be Undervalued or Deep Value.
  // Top picks always qualify regardless of valuation.
  const minConv = cfg.minSuggestedFindsConviction;
  const tops = topPickTickers ?? new Set<string>();
  const qualified = stocks.filter(s => {
    const conv = s.conviction ?? 0;
    if (conv < minConv) return false;
    if (tops.has(s.ticker)) return true; // top pick — always buy
    const tag = (s.valuationTag ?? '').toLowerCase();
    return tag === 'deep value' || tag === 'undervalued';
  });
  if (qualified.length === 0) {
    logEvent('*', 'info', 'No Suggested Finds meet conviction + valuation threshold');
    return [];
  }

  logEvent('*', 'info', `Processing ${qualified.length} Suggested Finds (conviction ${minConv}+ and undervalued/deep value)...`);

  const toProcess = qualified.slice(0, slotsAvailable);

  for (const stock of toProcess) {
    const result = await processSuggestedFind(stock, cfg);
    results.push(result);

    // Small delay between orders
    if (toProcess.indexOf(stock) < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return results;
}

/** Process a single Suggested Find stock — long-term buy, no swing/day analysis */
async function processSuggestedFind(
  stock: EnhancedSuggestedStock,
  config: AutoTraderConfig
): Promise<ProcessResult> {
  const { ticker } = stock;
  const conviction = stock.conviction ?? 0;
  const source = stock.tag === 'Steady Compounder' ? 'Quiet Compounder' : 'Gold Mine';
  const sfMeta = { conviction, valuation_tag: stock.valuationTag, source_type: source };

  // ── 1. Dedup check ──
  const alreadyActive = await hasActiveTrade(ticker);
  if (alreadyActive) {
    logEvent(ticker, 'info', `Already have active position (${source}) — skipping`);
    persistEvent(ticker, 'info', `Already have active position (${source}) — skipping`, {
      action: 'skipped', source: 'suggested_finds', mode: 'SWING_TRADE',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'Duplicate position', metadata: sfMeta,
    });
    return { ticker, action: 'skipped', reason: 'Duplicate position' };
  }

  // ── 2. Get current price for position sizing ──
  // For long-term holds we skip swing/day analysis — conviction + valuation already vetted.
  logEvent(ticker, 'info', `${source} — conviction ${conviction}/10, buying at market (long-term hold)`);

  const currentPrice = await getQuotePrice(ticker);
  if (!currentPrice) {
    const msg = `Could not fetch current price for ${source}`;
    logEvent(ticker, 'error', msg);
    persistEvent(ticker, 'error', msg, {
      action: 'failed', source: 'suggested_finds',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'Price lookup failed', metadata: sfMeta,
    });
    return { ticker, action: 'failed', reason: 'Price lookup failed' };
  }

  const quantity = Math.max(1, Math.floor(config.positionSize / currentPrice));

  // ── 3. Search IB Contract ──
  const contract = await searchContract(ticker);
  if (!contract) {
    logEvent(ticker, 'error', `Stock not found on IB (${source})`);
    persistEvent(ticker, 'error', `Stock not found on IB (${source})`, {
      action: 'failed', source: 'suggested_finds',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'IB contract not found', metadata: sfMeta,
    });
    return { ticker, action: 'failed', reason: 'IB contract not found' };
  }

  // ── 4. Place Market Buy (no bracket — long-term hold, no stop loss/target) ──
  logEvent(ticker, 'info', `Placing market BUY: ${quantity} shares (~$${(quantity * currentPrice).toFixed(0)}) [${source}]`);

  try {
    const orderReplies = await placeMarketOrder({
      accountId: config.accountId!,
      conid: contract.conid,
      side: 'BUY',
      quantity,
      symbol: ticker,
    });

    const finalReplies = await handleOrderConfirmations(orderReplies);
    const orderId = finalReplies[0]?.order_id ?? null;

    // ── 5. Log Trade ──
    const trade = await createPaperTrade({
      ticker,
      mode: 'SWING_TRADE',
      signal: 'BUY',
      scanner_confidence: conviction,
      fa_confidence: conviction,        // no FA — use conviction as confidence proxy
      fa_recommendation: 'BUY',
      entry_price: currentPrice,
      stop_loss: null,                  // no stop loss for long-term holds
      target_price: null,               // no target — hold indefinitely
      quantity,
      position_size: quantity * currentPrice,
      ib_order_id: orderId,
      status: 'SUBMITTED',
      scanner_reason: `${source}: ${stock.reason}`,
      fa_rationale: null,
      notes: `Long-term hold | ${source} | Conviction: ${conviction}/10 | ${stock.valuationTag ?? ''}`,
    });

    const msg = `${source} market BUY placed! ${quantity} shares of ${ticker} @ ~$${currentPrice.toFixed(2)}`;
    logEvent(ticker, 'success', msg);
    persistEvent(ticker, 'success', msg, {
      action: 'executed', source: 'suggested_finds', mode: 'SWING_TRADE',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      fa_recommendation: 'BUY', fa_confidence: conviction,
      metadata: { ...sfMeta, current_price: currentPrice, quantity, order_type: 'MARKET' },
    });
    return { ticker, action: 'executed', reason: 'Market order placed successfully', trade };
  } catch (err) {
    const msg = `Order failed for ${source}: ${err instanceof Error ? err.message : 'Unknown'}`;
    logEvent(ticker, 'error', msg);
    persistEvent(ticker, 'error', msg, {
      action: 'failed', source: 'suggested_finds',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'Order rejected by IB', metadata: sfMeta,
    });

    await createPaperTrade({
      ticker,
      mode: 'SWING_TRADE',
      signal: 'BUY',
      scanner_confidence: conviction,
      fa_confidence: conviction,
      fa_recommendation: 'BUY',
      entry_price: currentPrice,
      stop_loss: null,
      target_price: null,
      quantity,
      position_size: quantity * currentPrice,
      status: 'REJECTED',
      notes: `${source} order rejected: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });

    return { ticker, action: 'failed', reason: `Order rejected: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

// ── Position Sync ────────────────────────────────────────

/**
 * Sync IB positions with paper_trades table.
 * 1. Detect fills — IB has position → mark SUBMITTED → FILLED
 * 2. Detect closes — position disappeared → fetch close price → calculate P&L
 * 3. Expire stale day trades — SUBMITTED day trades older than 1 day → EXPIRED
 */
export async function syncPositions(accountId: string): Promise<void> {
  try {
    const [ibPositions, activeTrades] = await Promise.all([
      getPositions(accountId),
      getActiveTrades(),
    ]);

    for (const trade of activeTrades) {
      const ibPos = ibPositions.find(
        p => p.contractDesc.toUpperCase() === trade.ticker.toUpperCase()
      );

      if (ibPos && ibPos.position !== 0) {
        // ── Position is open on IB ──
        if (trade.status === 'SUBMITTED' || trade.status === 'PENDING') {
          await updatePaperTrade(trade.id, {
            status: 'FILLED',
            fill_price: ibPos.avgPrice,
            filled_at: new Date().toISOString(),
          });
          logEvent(trade.ticker, 'success', `Filled @ $${ibPos.avgPrice.toFixed(2)}`);
        }

        // Update unrealized P&L if we have market price (enriched positions)
        if (trade.status === 'FILLED' && ibPos.mktPrice > 0 && trade.fill_price) {
          const qty = trade.quantity ?? 1;
          const isLong = trade.signal === 'BUY';
          const unrealizedPnl = isLong
            ? (ibPos.mktPrice - trade.fill_price) * qty
            : (trade.fill_price - ibPos.mktPrice) * qty;

          // Update pnl fields (unrealized while position is open)
          await updatePaperTrade(trade.id, {
            pnl: parseFloat(unrealizedPnl.toFixed(2)),
            pnl_percent: parseFloat(((unrealizedPnl / (trade.fill_price * qty)) * 100).toFixed(2)),
          });
        }

      } else if (trade.status === 'FILLED') {
        // ── Position was open but now gone — closed (stop/target/manual) ──
        // Fetch current price to approximate close price
        const closePrice = await getQuotePrice(trade.ticker);
        const fillPrice = trade.fill_price ?? trade.entry_price ?? 0;
        const qty = trade.quantity ?? 1;
        const isLong = trade.signal === 'BUY';

        let pnl: number;
        let actualClosePrice: number;

        if (closePrice) {
          actualClosePrice = closePrice;
        } else {
          // Fallback: use target or stop based on position direction
          actualClosePrice = fillPrice; // worst case: breakeven
        }

        pnl = isLong
          ? (actualClosePrice - fillPrice) * qty
          : (fillPrice - actualClosePrice) * qty;

        // Infer close reason from P&L and price levels
        let closeReason: 'stop_loss' | 'target_hit' | 'manual' = 'manual';
        if (trade.stop_loss && trade.target_price) {
          if (isLong) {
            if (actualClosePrice >= trade.target_price) closeReason = 'target_hit';
            else if (actualClosePrice <= trade.stop_loss) closeReason = 'stop_loss';
          } else {
            if (actualClosePrice <= trade.target_price) closeReason = 'target_hit';
            else if (actualClosePrice >= trade.stop_loss) closeReason = 'stop_loss';
          }
        }
        // No stop/target (e.g. suggested finds) — infer from P&L
        if (closeReason === 'manual' && pnl > 0) closeReason = 'target_hit';
        if (closeReason === 'manual' && pnl < 0) closeReason = 'stop_loss';

        const status = closeReason === 'stop_loss' ? 'STOPPED'
          : closeReason === 'target_hit' ? 'TARGET_HIT'
          : 'CLOSED';

        await updatePaperTrade(trade.id, {
          status: status as PaperTrade['status'],
          close_reason: closeReason,
          close_price: actualClosePrice,
          closed_at: new Date().toISOString(),
          pnl: parseFloat(pnl.toFixed(2)),
          pnl_percent: fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null,
        });

        const emoji = pnl > 0 ? 'success' : pnl < 0 ? 'warning' : 'info';
        logEvent(trade.ticker, emoji as 'success' | 'warning' | 'info',
          `Position closed (${closeReason}): P&L $${pnl.toFixed(2)} (${((pnl / (fillPrice * qty)) * 100).toFixed(1)}%)`);

        // Persist the close event
        persistEvent(trade.ticker, emoji as 'success' | 'warning' | 'info',
          `Closed: ${closeReason} — P&L $${pnl.toFixed(2)}`, {
            action: pnl >= 0 ? 'executed' : 'failed',
            source: 'system',
            metadata: { close_price: actualClosePrice, pnl, close_reason: closeReason },
          });

        // Trigger AI trade analysis (non-blocking)
        const closedTrade: PaperTrade = {
          ...trade,
          status: status as PaperTrade['status'],
          close_reason: closeReason,
          close_price: actualClosePrice,
          closed_at: new Date().toISOString(),
          pnl: parseFloat(pnl.toFixed(2)),
          pnl_percent: fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null,
        };
        analyzeCompletedTrade(closedTrade)
          .then(() => updatePerformancePatterns())
          .catch(err => console.warn('[syncPositions] Trade analysis failed:', err));

      } else if (trade.status === 'SUBMITTED') {
        // ── Stale SUBMITTED trades — expire day trades older than 1 day ──
        const tradeAge = Date.now() - new Date(trade.created_at).getTime();
        const oneDayMs = 24 * 60 * 60 * 1000;

        if (trade.mode === 'DAY_TRADE' && tradeAge > oneDayMs) {
          await updatePaperTrade(trade.id, {
            status: 'CLOSED' as PaperTrade['status'],
            close_reason: 'manual',
            closed_at: new Date().toISOString(),
            notes: (trade.notes ?? '') + ' | Expired: DAY order not filled within 1 day',
          });
          logEvent(trade.ticker, 'info', 'Day trade expired — order never filled');
        }
      }
    }
  } catch (err) {
    logEvent('*', 'error', `Position sync failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}
