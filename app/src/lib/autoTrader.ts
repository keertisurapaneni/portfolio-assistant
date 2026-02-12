/**
 * Auto-Trader — orchestrates the full flow:
 *   Scanner idea → Full Analysis → Risk check → IB bracket order → Log trade
 *   Suggested Finds → Full Analysis → Risk check → IB bracket order → Log trade
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
  type PaperTrade,
} from './paperTradesApi';

// ── Configuration ────────────────────────────────────────

export interface AutoTraderConfig {
  enabled: boolean;
  maxPositions: number;          // max concurrent positions
  positionSize: number;          // $ per position (paper money)
  minScannerConfidence: number;  // min scanner confidence to consider
  minFAConfidence: number;       // min FA confidence to execute
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
    return { ticker, action: 'skipped', reason: 'Duplicate position' };
  }

  // ── 2. Run Full Analysis ──
  logEvent(ticker, 'info', `Running full analysis (${mode})...`);
  let fa: TradingSignalsResponse;
  try {
    const faMode: SignalsMode = mode === 'DAY_TRADE' ? 'DAY_TRADE' : 'SWING_TRADE';
    fa = await fetchTradingSignal(ticker, faMode);
  } catch (err) {
    logEvent(ticker, 'error', `FA failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    return { ticker, action: 'failed', reason: 'Full analysis failed' };
  }

  // ── 3. Confidence Gate ──
  const faConf = fa.trade.confidence;
  const faRec = fa.trade.recommendation;

  if (faConf < config.minFAConfidence) {
    logEvent(ticker, 'info', `FA confidence too low: ${faConf}/10 (need ${config.minFAConfidence}+)`);
    return { ticker, action: 'skipped', reason: `FA confidence ${faConf} < ${config.minFAConfidence}` };
  }

  if (faRec === 'HOLD') {
    logEvent(ticker, 'info', 'FA says HOLD — skipping');
    return { ticker, action: 'skipped', reason: 'FA recommendation is HOLD' };
  }

  // ── 4. Direction Consistency ──
  if (faRec !== signal) {
    logEvent(ticker, 'warning', `Scanner says ${signal} but FA says ${faRec} — skipping`);
    return { ticker, action: 'skipped', reason: `Direction mismatch: scanner ${signal} vs FA ${faRec}` };
  }

  // ── 5. Entry/Stop/Target validation ──
  const { entryPrice, stopLoss, targetPrice } = fa.trade;
  if (!entryPrice || !stopLoss || !targetPrice) {
    logEvent(ticker, 'warning', 'FA missing entry/stop/target — skipping');
    return { ticker, action: 'skipped', reason: 'Missing price levels from FA' };
  }

  // ── 6. Position Sizing ──
  const quantity = Math.floor(config.positionSize / entryPrice);
  if (quantity < 1) {
    logEvent(ticker, 'warning', `Position size too small: $${config.positionSize} / $${entryPrice} < 1 share`);
    return { ticker, action: 'skipped', reason: 'Position size too small for 1 share' };
  }

  // ── 7. Search IB Contract ──
  logEvent(ticker, 'info', 'Searching IB contract...');
  const contract = await searchContract(ticker);
  if (!contract) {
    logEvent(ticker, 'error', 'Stock not found on IB');
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

    logEvent(ticker, 'success', `Order placed! ${signal} ${quantity} shares @ $${entryPrice}`);

    return { ticker, action: 'executed', reason: 'Order placed successfully', trade };
  } catch (err) {
    logEvent(ticker, 'error', `Order failed: ${err instanceof Error ? err.message : 'Unknown'}`);

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
 * Stocks with conviction >= 7 get a full swing analysis → bracket order.
 *
 * These are long-term positions: always SWING_TRADE mode, GTC orders.
 */
export async function processSuggestedFinds(
  stocks: EnhancedSuggestedStock[],
  config?: AutoTraderConfig
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

  // Filter by conviction >= 7
  const qualified = stocks.filter(s => (s.conviction ?? 0) >= cfg.minScannerConfidence);
  if (qualified.length === 0) {
    logEvent('*', 'info', 'No Suggested Finds meet conviction threshold');
    return [];
  }

  logEvent('*', 'info', `Processing ${qualified.length} Suggested Finds with conviction 7+...`);

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

/** Process a single Suggested Find stock */
async function processSuggestedFind(
  stock: EnhancedSuggestedStock,
  config: AutoTraderConfig
): Promise<ProcessResult> {
  const { ticker } = stock;
  const conviction = stock.conviction ?? 0;
  const source = stock.tag === 'Steady Compounder' ? 'Quiet Compounder' : 'Gold Mine';

  // ── 1. Dedup check ──
  const alreadyActive = await hasActiveTrade(ticker);
  if (alreadyActive) {
    logEvent(ticker, 'info', `Already have active position (${source}) — skipping`);
    return { ticker, action: 'skipped', reason: 'Duplicate position' };
  }

  // ── 2. Run Full Swing Analysis ──
  logEvent(ticker, 'info', `Running swing analysis for ${source} (conviction: ${conviction}/10)...`);
  let fa: TradingSignalsResponse;
  try {
    fa = await fetchTradingSignal(ticker, 'SWING_TRADE');
  } catch (err) {
    logEvent(ticker, 'error', `FA failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    return { ticker, action: 'failed', reason: 'Full analysis failed' };
  }

  // ── 3. Confidence Gate (use FA confidence) ──
  const faConf = fa.trade.confidence;
  const faRec = fa.trade.recommendation;

  if (faConf < config.minFAConfidence) {
    logEvent(ticker, 'info', `FA confidence too low: ${faConf}/10 (need ${config.minFAConfidence}+) for ${source}`);
    return { ticker, action: 'skipped', reason: `FA confidence ${faConf} < ${config.minFAConfidence}` };
  }

  // Suggested Finds are always BUY candidates — skip if FA says SELL or HOLD
  if (faRec !== 'BUY') {
    logEvent(ticker, 'info', `FA says ${faRec} for ${source} — skipping (only buying)`);
    return { ticker, action: 'skipped', reason: `FA recommendation is ${faRec}, not BUY` };
  }

  // ── 4. Entry/Stop/Target validation ──
  const { entryPrice, stopLoss, targetPrice } = fa.trade;
  if (!entryPrice || !stopLoss || !targetPrice) {
    logEvent(ticker, 'warning', `FA missing entry/stop/target for ${source} — skipping`);
    return { ticker, action: 'skipped', reason: 'Missing price levels from FA' };
  }

  // ── 5. Position Sizing ──
  const quantity = Math.floor(config.positionSize / entryPrice);
  if (quantity < 1) {
    logEvent(ticker, 'warning', `Position size too small for ${source}: $${config.positionSize} / $${entryPrice}`);
    return { ticker, action: 'skipped', reason: 'Position size too small for 1 share' };
  }

  // ── 6. Search IB Contract ──
  logEvent(ticker, 'info', `Searching IB contract for ${source}...`);
  const contract = await searchContract(ticker);
  if (!contract) {
    logEvent(ticker, 'error', `Stock not found on IB (${source})`);
    return { ticker, action: 'failed', reason: 'IB contract not found' };
  }

  // ── 7. Place Bracket Order (always GTC for long-term holds) ──
  logEvent(ticker, 'info', `Placing bracket order: BUY ${quantity} @ $${entryPrice} (SL: $${stopLoss}, TP: $${targetPrice}) [${source}]`);

  try {
    const orderReplies = await placeBracketOrder({
      accountId: config.accountId!,
      conid: contract.conid,
      symbol: ticker,
      side: 'BUY',
      quantity,
      entryPrice,
      stopLoss,
      takeProfit: targetPrice,
      tif: 'GTC',
    });

    const finalReplies = await handleOrderConfirmations(orderReplies);
    const orderId = finalReplies[0]?.order_id ?? null;

    // ── 8. Log Trade ──
    const trade = await createPaperTrade({
      ticker,
      mode: 'SWING_TRADE',
      signal: 'BUY',
      scanner_confidence: conviction,
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
      scanner_reason: `${source}: ${stock.reason}`,
      fa_rationale: fa.trade.rationale,
      notes: `Source: ${source} | Conviction: ${conviction}/10 | ${stock.valuationTag ?? ''} | ${stock.aiImpact ?? ''}`,
    });

    logEvent(ticker, 'success', `${source} order placed! BUY ${quantity} shares @ $${entryPrice}`);
    return { ticker, action: 'executed', reason: 'Order placed successfully', trade };
  } catch (err) {
    logEvent(ticker, 'error', `Order failed for ${source}: ${err instanceof Error ? err.message : 'Unknown'}`);

    await createPaperTrade({
      ticker,
      mode: 'SWING_TRADE',
      signal: 'BUY',
      scanner_confidence: conviction,
      fa_confidence: faConf,
      fa_recommendation: faRec,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      target_price: targetPrice,
      quantity,
      position_size: quantity * entryPrice,
      status: 'REJECTED',
      notes: `${source} order rejected: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });

    return { ticker, action: 'failed', reason: `Order rejected: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

// ── Position Sync ────────────────────────────────────────

/**
 * Sync IB positions with paper_trades table.
 * Updates fill status, P&L, and detects closed positions.
 */
export async function syncPositions(accountId: string): Promise<void> {
  try {
    const [ibPositions, activeTrades] = await Promise.all([
      getPositions(accountId),
      getActiveTrades(),
    ]);

    for (const trade of activeTrades) {
      const ibPos = ibPositions.find(
        p => p.contractDesc.toUpperCase().includes(trade.ticker.toUpperCase())
      );

      if (ibPos && ibPos.position !== 0) {
        // Position is open on IB
        if (trade.status === 'SUBMITTED' || trade.status === 'PENDING') {
          await updatePaperTrade(trade.id, {
            status: 'FILLED',
            fill_price: ibPos.avgPrice,
            filled_at: new Date().toISOString(),
          });
          logEvent(trade.ticker, 'success', `Filled @ $${ibPos.avgPrice.toFixed(2)}`);
        }
      } else if (trade.status === 'FILLED') {
        // Position was open but now gone — closed by stop/target
        const pnl = ibPositions.find(
          p => p.contractDesc.toUpperCase().includes(trade.ticker.toUpperCase())
        )?.realizedPnl ?? null;

        let closeReason: 'stop_loss' | 'target_hit' | 'manual' = 'manual';
        if (trade.fill_price && trade.stop_loss && trade.target_price) {
          // Infer close reason from P&L direction
          if (pnl !== null && pnl < 0) closeReason = 'stop_loss';
          else if (pnl !== null && pnl > 0) closeReason = 'target_hit';
        }

        await updatePaperTrade(trade.id, {
          status: closeReason === 'stop_loss' ? 'STOPPED' : closeReason === 'target_hit' ? 'TARGET_HIT' : 'CLOSED',
          close_reason: closeReason,
          closed_at: new Date().toISOString(),
          pnl: pnl,
          pnl_percent: trade.fill_price ? ((pnl ?? 0) / (trade.fill_price * (trade.quantity ?? 1))) * 100 : null,
        });

        logEvent(trade.ticker, pnl && pnl > 0 ? 'success' : 'warning',
          `Position closed (${closeReason}): P&L $${pnl?.toFixed(2) ?? '?'}`);
      }
    }
  } catch (err) {
    logEvent('*', 'error', `Position sync failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}
