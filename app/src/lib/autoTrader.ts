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
import { supabase } from './supabaseClient';

// ── In-memory pending order tracker ──────────────────────
// After placing an order, IB takes seconds to reflect the new position.
// Track pending dollar amounts here to prevent concurrent allocation cap bypasses.
let _pendingDeployedDollar = 0;
const _pendingOrders: { ticker: string; dollarSize: number; ts: number }[] = [];
const PENDING_ORDER_TTL_MS = 5 * 60 * 1000; // Forget after 5 minutes (IB will have reflected by then)

/** Record a pending order so getTotalDeployed() includes it */
function recordPendingOrder(ticker: string, dollarSize: number) {
  _pendingOrders.push({ ticker, dollarSize, ts: Date.now() });
  _pendingDeployedDollar += dollarSize;
  // Also track daily deployment
  recordDailyDeployment(dollarSize);
}

/** Expire old pending orders (IB should have reflected them by now) */
function expirePendingOrders() {
  const cutoff = Date.now() - PENDING_ORDER_TTL_MS;
  while (_pendingOrders.length > 0 && _pendingOrders[0].ts < cutoff) {
    const expired = _pendingOrders.shift()!;
    _pendingDeployedDollar -= expired.dollarSize;
  }
  // Safety: never go negative
  if (_pendingDeployedDollar < 0) _pendingDeployedDollar = 0;
}

/** Reset pending orders (call when syncing positions from IB — IB is now the source of truth) */
export function resetPendingOrders() {
  _pendingOrders.length = 0;
  _pendingDeployedDollar = 0;
}

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
  positionSize: number;          // $ per position (paper money) — fallback when dynamic sizing off
  minScannerConfidence: number;  // min scanner confidence to consider
  minFAConfidence: number;       // min FA confidence to execute
  minSuggestedFindsConviction: number; // min conviction for Suggested Finds auto-buy
  accountId: string | null;      // IB paper account ID
  dayTradeAutoClose: boolean;    // auto-close day trades at 3:55 PM ET

  // ── Allocation Cap ──
  maxTotalAllocation: number;    // hard cap on total deployed capital ($400K default)
  maxDailyDeployment: number;    // max NEW capital deployed in a single day ($50K default)

  // ── Layer 1: Dynamic Position Sizing ──
  useDynamicSizing: boolean;     // use conviction-weighted + risk-based sizing
  portfolioValue: number;        // total portfolio value (auto-updated from IB)
  baseAllocationPct: number;     // base % of portfolio per long-term position
  maxPositionPct: number;        // max single-position % of portfolio
  riskPerTradePct: number;       // max risk % per scanner trade

  // ── Layer 2: Dip Buying ──
  dipBuyEnabled: boolean;
  dipBuyTier1Pct: number;        // dip % to trigger tier 1
  dipBuyTier1SizePct: number;    // add-on % of original qty
  dipBuyTier2Pct: number;
  dipBuyTier2SizePct: number;
  dipBuyTier3Pct: number;
  dipBuyTier3SizePct: number;
  dipBuyCooldownHours: number;   // min hours between dip buys for same ticker

  // ── Layer 3: Profit Taking ──
  profitTakeEnabled: boolean;
  profitTakeTier1Pct: number;    // gain % to trigger tier 1
  profitTakeTier1TrimPct: number;// trim % of position
  profitTakeTier2Pct: number;
  profitTakeTier2TrimPct: number;
  profitTakeTier3Pct: number;
  profitTakeTier3TrimPct: number;
  minHoldPct: number;            // never sell below this % of original qty

  // ── Layer 3b: Loss Cutting ──
  lossCutEnabled: boolean;       // auto-sell losers to protect capital
  lossCutTier1Pct: number;       // loss % to trigger tier 1 (e.g. 8%)
  lossCutTier1SellPct: number;   // sell % of position at tier 1
  lossCutTier2Pct: number;       // loss % for tier 2
  lossCutTier2SellPct: number;
  lossCutTier3Pct: number;       // loss % for tier 3 (full exit)
  lossCutTier3SellPct: number;
  lossCutMinHoldDays: number;    // minimum days held before loss-cutting (avoid intraday noise)

  // ── Layer 4: Risk Management ──
  marketRegimeEnabled: boolean;  // adjust sizing for VIX/SPY conditions
  maxSectorPct: number;          // max portfolio % in one sector
  earningsAvoidEnabled: boolean; // skip trades near earnings
  earningsBlackoutDays: number;  // days before earnings to blackout
  kellyAdaptiveEnabled: boolean; // use Half-Kelly from trade history win rate
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

  // Allocation Cap
  maxTotalAllocation: 500_000,
  maxDailyDeployment: 50_000,

  // Layer 1: Dynamic Sizing
  useDynamicSizing: true,
  portfolioValue: 1_000_000,
  baseAllocationPct: 2.0,
  maxPositionPct: 5.0,
  riskPerTradePct: 1.0,

  // Layer 2: Dip Buying (conservative — don't throw good money after bad)
  dipBuyEnabled: true,
  dipBuyTier1Pct: 10,
  dipBuyTier1SizePct: 25,
  dipBuyTier2Pct: 20,
  dipBuyTier2SizePct: 50,
  dipBuyTier3Pct: 30,
  dipBuyTier3SizePct: 75,
  dipBuyCooldownHours: 72,

  // Layer 3: Profit Taking (aggressive — generate income, trim winners early)
  profitTakeEnabled: true,
  profitTakeTier1Pct: 8,
  profitTakeTier1TrimPct: 25,
  profitTakeTier2Pct: 15,
  profitTakeTier2TrimPct: 30,
  profitTakeTier3Pct: 25,
  profitTakeTier3TrimPct: 30,
  minHoldPct: 15,

  // Layer 3b: Loss Cutting (protect capital — sell losers before they get worse)
  lossCutEnabled: true,
  lossCutTier1Pct: 8,
  lossCutTier1SellPct: 30,
  lossCutTier2Pct: 15,
  lossCutTier2SellPct: 50,
  lossCutTier3Pct: 25,
  lossCutTier3SellPct: 100,
  lossCutMinHoldDays: 2,

  // Layer 4: Risk Management
  marketRegimeEnabled: true,
  maxSectorPct: 30,
  earningsAvoidEnabled: true,
  earningsBlackoutDays: 3,
  kellyAdaptiveEnabled: false,
};

/**
 * Get config synchronously from localStorage cache.
 * Call loadAutoTraderConfig() on app startup to sync from Supabase.
 */
export function getAutoTraderConfig(): AutoTraderConfig {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

/** Load config from Supabase and cache in localStorage. Call on app startup. */
export async function loadAutoTraderConfig(): Promise<AutoTraderConfig> {
  try {
    const { data, error } = await supabase
      .from('auto_trader_config')
      .select('*')
      .eq('id', 'default')
      .single();

    if (!error && data) {
      const config: AutoTraderConfig = {
        enabled: data.enabled ?? DEFAULT_CONFIG.enabled,
        maxPositions: data.max_positions ?? DEFAULT_CONFIG.maxPositions,
        positionSize: Number(data.position_size) || DEFAULT_CONFIG.positionSize,
        minScannerConfidence: data.min_scanner_confidence ?? DEFAULT_CONFIG.minScannerConfidence,
        minFAConfidence: data.min_fa_confidence ?? DEFAULT_CONFIG.minFAConfidence,
        minSuggestedFindsConviction: data.min_suggested_finds_conviction ?? DEFAULT_CONFIG.minSuggestedFindsConviction,
        accountId: data.account_id ?? DEFAULT_CONFIG.accountId,
        dayTradeAutoClose: data.day_trade_auto_close ?? DEFAULT_CONFIG.dayTradeAutoClose,

        // Allocation cap
        maxTotalAllocation: Number(data.max_total_allocation) || DEFAULT_CONFIG.maxTotalAllocation,
        maxDailyDeployment: Number(data.max_daily_deployment) || DEFAULT_CONFIG.maxDailyDeployment,

        // Layer 1
        useDynamicSizing: data.use_dynamic_sizing ?? DEFAULT_CONFIG.useDynamicSizing,
        portfolioValue: Number(data.portfolio_value) || DEFAULT_CONFIG.portfolioValue,
        baseAllocationPct: Number(data.base_allocation_pct) || DEFAULT_CONFIG.baseAllocationPct,
        maxPositionPct: Number(data.max_position_pct) || DEFAULT_CONFIG.maxPositionPct,
        riskPerTradePct: Number(data.risk_per_trade_pct) || DEFAULT_CONFIG.riskPerTradePct,

        // Layer 2
        dipBuyEnabled: data.dip_buy_enabled ?? DEFAULT_CONFIG.dipBuyEnabled,
        dipBuyTier1Pct: Number(data.dip_buy_tier1_pct) || DEFAULT_CONFIG.dipBuyTier1Pct,
        dipBuyTier1SizePct: Number(data.dip_buy_tier1_size_pct) || DEFAULT_CONFIG.dipBuyTier1SizePct,
        dipBuyTier2Pct: Number(data.dip_buy_tier2_pct) || DEFAULT_CONFIG.dipBuyTier2Pct,
        dipBuyTier2SizePct: Number(data.dip_buy_tier2_size_pct) || DEFAULT_CONFIG.dipBuyTier2SizePct,
        dipBuyTier3Pct: Number(data.dip_buy_tier3_pct) || DEFAULT_CONFIG.dipBuyTier3Pct,
        dipBuyTier3SizePct: Number(data.dip_buy_tier3_size_pct) || DEFAULT_CONFIG.dipBuyTier3SizePct,
        dipBuyCooldownHours: data.dip_buy_cooldown_hours ?? DEFAULT_CONFIG.dipBuyCooldownHours,

        // Layer 3
        profitTakeEnabled: data.profit_take_enabled ?? DEFAULT_CONFIG.profitTakeEnabled,
        profitTakeTier1Pct: Number(data.profit_take_tier1_pct) || DEFAULT_CONFIG.profitTakeTier1Pct,
        profitTakeTier1TrimPct: Number(data.profit_take_tier1_trim_pct) || DEFAULT_CONFIG.profitTakeTier1TrimPct,
        profitTakeTier2Pct: Number(data.profit_take_tier2_pct) || DEFAULT_CONFIG.profitTakeTier2Pct,
        profitTakeTier2TrimPct: Number(data.profit_take_tier2_trim_pct) || DEFAULT_CONFIG.profitTakeTier2TrimPct,
        profitTakeTier3Pct: Number(data.profit_take_tier3_pct) || DEFAULT_CONFIG.profitTakeTier3Pct,
        profitTakeTier3TrimPct: Number(data.profit_take_tier3_trim_pct) || DEFAULT_CONFIG.profitTakeTier3TrimPct,
        minHoldPct: Number(data.min_hold_pct) || DEFAULT_CONFIG.minHoldPct,

        // Layer 3b: Loss Cutting
        lossCutEnabled: data.loss_cut_enabled ?? DEFAULT_CONFIG.lossCutEnabled,
        lossCutTier1Pct: Number(data.loss_cut_tier1_pct) || DEFAULT_CONFIG.lossCutTier1Pct,
        lossCutTier1SellPct: Number(data.loss_cut_tier1_sell_pct) || DEFAULT_CONFIG.lossCutTier1SellPct,
        lossCutTier2Pct: Number(data.loss_cut_tier2_pct) || DEFAULT_CONFIG.lossCutTier2Pct,
        lossCutTier2SellPct: Number(data.loss_cut_tier2_sell_pct) || DEFAULT_CONFIG.lossCutTier2SellPct,
        lossCutTier3Pct: Number(data.loss_cut_tier3_pct) || DEFAULT_CONFIG.lossCutTier3Pct,
        lossCutTier3SellPct: Number(data.loss_cut_tier3_sell_pct) || DEFAULT_CONFIG.lossCutTier3SellPct,
        lossCutMinHoldDays: data.loss_cut_min_hold_days ?? DEFAULT_CONFIG.lossCutMinHoldDays,

        // Layer 4
        marketRegimeEnabled: data.market_regime_enabled ?? DEFAULT_CONFIG.marketRegimeEnabled,
        maxSectorPct: Number(data.max_sector_pct) || DEFAULT_CONFIG.maxSectorPct,
        earningsAvoidEnabled: data.earnings_avoid_enabled ?? DEFAULT_CONFIG.earningsAvoidEnabled,
        earningsBlackoutDays: data.earnings_blackout_days ?? DEFAULT_CONFIG.earningsBlackoutDays,
        kellyAdaptiveEnabled: data.kelly_adaptive_enabled ?? DEFAULT_CONFIG.kellyAdaptiveEnabled,
      };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return config;
    }
  } catch (err) {
    console.warn('[AutoTrader] Failed to load config from Supabase:', err);
  }

  // Fallback: use localStorage or defaults
  return getAutoTraderConfig();
}

/** Save config to both Supabase (persistent) and localStorage (fast cache). */
export async function saveAutoTraderConfig(config: Partial<AutoTraderConfig>): Promise<AutoTraderConfig> {
  const current = getAutoTraderConfig();
  const updated = { ...current, ...config };

  // Cache locally for immediate use
  localStorage.setItem(CONFIG_KEY, JSON.stringify(updated));

  // Persist to Supabase (non-blocking for UI, but we await for callers that care)
  try {
    await supabase
      .from('auto_trader_config')
      .upsert({
        id: 'default',
        enabled: updated.enabled,
        max_positions: updated.maxPositions,
        position_size: updated.positionSize,
        min_scanner_confidence: updated.minScannerConfidence,
        min_fa_confidence: updated.minFAConfidence,
        min_suggested_finds_conviction: updated.minSuggestedFindsConviction,
        account_id: updated.accountId,
        day_trade_auto_close: updated.dayTradeAutoClose,
        // Allocation cap
        max_total_allocation: updated.maxTotalAllocation,
        max_daily_deployment: updated.maxDailyDeployment,
        // Layer 1
        use_dynamic_sizing: updated.useDynamicSizing,
        portfolio_value: updated.portfolioValue,
        base_allocation_pct: updated.baseAllocationPct,
        max_position_pct: updated.maxPositionPct,
        risk_per_trade_pct: updated.riskPerTradePct,
        // Layer 2
        dip_buy_enabled: updated.dipBuyEnabled,
        dip_buy_tier1_pct: updated.dipBuyTier1Pct,
        dip_buy_tier1_size_pct: updated.dipBuyTier1SizePct,
        dip_buy_tier2_pct: updated.dipBuyTier2Pct,
        dip_buy_tier2_size_pct: updated.dipBuyTier2SizePct,
        dip_buy_tier3_pct: updated.dipBuyTier3Pct,
        dip_buy_tier3_size_pct: updated.dipBuyTier3SizePct,
        dip_buy_cooldown_hours: updated.dipBuyCooldownHours,
        // Layer 3
        profit_take_enabled: updated.profitTakeEnabled,
        profit_take_tier1_pct: updated.profitTakeTier1Pct,
        profit_take_tier1_trim_pct: updated.profitTakeTier1TrimPct,
        profit_take_tier2_pct: updated.profitTakeTier2Pct,
        profit_take_tier2_trim_pct: updated.profitTakeTier2TrimPct,
        profit_take_tier3_pct: updated.profitTakeTier3Pct,
        profit_take_tier3_trim_pct: updated.profitTakeTier3TrimPct,
        min_hold_pct: updated.minHoldPct,
        // Layer 3b: Loss Cutting
        loss_cut_enabled: updated.lossCutEnabled,
        loss_cut_tier1_pct: updated.lossCutTier1Pct,
        loss_cut_tier1_sell_pct: updated.lossCutTier1SellPct,
        loss_cut_tier2_pct: updated.lossCutTier2Pct,
        loss_cut_tier2_sell_pct: updated.lossCutTier2SellPct,
        loss_cut_tier3_pct: updated.lossCutTier3Pct,
        loss_cut_tier3_sell_pct: updated.lossCutTier3SellPct,
        loss_cut_min_hold_days: updated.lossCutMinHoldDays,
        // Layer 4
        market_regime_enabled: updated.marketRegimeEnabled,
        max_sector_pct: updated.maxSectorPct,
        earnings_avoid_enabled: updated.earningsAvoidEnabled,
        earnings_blackout_days: updated.earningsBlackoutDays,
        kelly_adaptive_enabled: updated.kellyAdaptiveEnabled,
        updated_at: new Date().toISOString(),
      });
  } catch (err) {
    console.warn('[AutoTrader] Failed to save config to Supabase:', err);
  }

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
    source?: 'scanner' | 'suggested_finds' | 'manual' | 'system' | 'dip_buy' | 'profit_take' | 'loss_cut';
    mode?: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
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

// ── Smart Trading: Allocation Cap ────────────────────────

/** Get total $ deployed across all active positions.
 *  Uses IB positions (shares × avgCost = real cost basis) as source of truth.
 *  Falls back to paper_trades.position_size when IB is unreachable. */
export async function getTotalDeployed(): Promise<number> {
  // Expire stale pending orders first
  expirePendingOrders();

  let ibDeployed = 0;
  try {
    const positions = await getPositions('');
    if (positions && positions.length > 0) {
      ibDeployed = positions.reduce((sum, p) => {
        const costBasis = Math.abs(p.position) * (p.avgCost ?? 0);
        return sum + costBasis;
      }, 0);
      // Include pending orders that IB hasn't reflected yet
      return ibDeployed + _pendingDeployedDollar;
    }
  } catch {
    // IB not connected — fall back to paper_trades
  }
  const trades = await getActiveTrades();
  const dbDeployed = trades.reduce((sum, t) => sum + (t.position_size ?? 0), 0);
  return dbDeployed + _pendingDeployedDollar;
}

// ── Daily deployment tracking ────────────────────────────
// Tracks how much NEW capital was deployed today (resets at midnight).
let _dailyDeployedDollar = 0;
let _dailyDeployedDate = '';

/** Record daily deployment for daily limit enforcement */
function recordDailyDeployment(dollarSize: number) {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyDeployedDate !== today) {
    _dailyDeployedDollar = 0;
    _dailyDeployedDate = today;
  }
  _dailyDeployedDollar += dollarSize;
}

/** Get today's total deployment (in-memory — fast, no DB query) */
function getTodayDeployed(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyDeployedDate !== today) {
    _dailyDeployedDollar = 0;
    _dailyDeployedDate = today;
  }
  return _dailyDeployedDollar;
}

/** Check if a new position fits within the allocation cap AND daily limit */
async function checkAllocationCap(
  config: AutoTraderConfig,
  positionSize: number,
  ticker: string,
): Promise<boolean> {
  const deployed = await getTotalDeployed();
  const cap = config.maxTotalAllocation;

  // CIRCUIT BREAKER: if already at or above 95% of cap, STOP all new trades
  if (deployed >= cap * 0.95) {
    const msg = `CIRCUIT BREAKER: Already at $${deployed.toFixed(0)} (${((deployed / cap) * 100).toFixed(1)}% of $${cap.toFixed(0)} cap) — blocking ALL new trades`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'system',
      skip_reason: 'Circuit breaker: at cap limit',
      metadata: { deployed, positionSize, cap, percentUsed: ((deployed / cap) * 100) },
    });
    return false;
  }

  // TOTAL ALLOCATION CHECK
  if (deployed + positionSize > cap) {
    const msg = `Allocation cap: $${deployed.toFixed(0)} + $${positionSize.toFixed(0)} > $${cap.toFixed(0)} limit`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'system',
      skip_reason: 'Allocation cap reached',
      metadata: { deployed, positionSize, cap },
    });
    return false;
  }

  // DAILY DEPLOYMENT LIMIT — prevents blowing through the budget in one day
  const dailyLimit = config.maxDailyDeployment;
  const todayDeployed = getTodayDeployed();
  if (todayDeployed + positionSize > dailyLimit) {
    const msg = `Daily limit: $${todayDeployed.toFixed(0)} + $${positionSize.toFixed(0)} > $${dailyLimit.toFixed(0)}/day — waiting until tomorrow`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'system',
      skip_reason: 'Daily deployment limit reached',
      metadata: { todayDeployed, positionSize, dailyLimit },
    });
    return false;
  }

  return true;
}

// ── Smart Trading: Layer 1 — Dynamic Position Sizing ─────

/** Conviction multiplier for long-term holds */
function convictionMultiplier(conviction: number): number {
  if (conviction >= 10) return 1.5;
  if (conviction >= 9) return 1.25;
  if (conviction >= 8) return 1.0;
  if (conviction >= 7) return 0.75;
  return 0.5;
}

/** Calculate position size in shares. Returns { quantity, dollarSize }. */
export function calculatePositionSize(
  config: AutoTraderConfig,
  params: {
    price: number;
    mode: 'LONG_TERM' | 'DAY_TRADE' | 'SWING_TRADE';
    conviction?: number;      // for long-term holds
    entryPrice?: number;      // for scanner trades
    stopLoss?: number;        // for scanner trades (risk-based sizing)
    regimeMultiplier?: number; // from market regime check
    kellyMultiplier?: number;  // from Half-Kelly
    drawdownMultiplier?: number; // from portfolio health (1.0 = normal, <1 = reduce)
  }
): { quantity: number; dollarSize: number } {
  const { price, mode, conviction, entryPrice, stopLoss, regimeMultiplier = 1.0, kellyMultiplier = 1.0, drawdownMultiplier = 1.0 } = params;

  const alloc = config.maxTotalAllocation;

  // HARD max single-position cap: 10% of allocation cap (e.g. 10% of $250K = $25K).
  // This applies ALWAYS — even when dynamic sizing is off — to prevent
  // a single trade from eating a huge chunk of the budget.
  const hardMaxDollar = alloc * 0.10;

  if (!config.useDynamicSizing || price <= 0) {
    // Fallback: flat position sizing, but STILL capped by allocation
    const cappedSize = Math.min(config.positionSize, hardMaxDollar);
    const qty = Math.max(1, Math.floor(cappedSize / price));
    return { quantity: qty, dollarSize: qty * price };
  }

  const pv = config.portfolioValue;

  // Max single-position cap: the SMALLER of:
  //   - max_position_pct of portfolio (e.g. 5% of $1M = $50K)
  //   - 10% of allocation cap (e.g. 10% of $250K = $25K)
  // This prevents one stock from eating 20%+ of the allocation.
  const maxDollar = Math.min(
    pv * (config.maxPositionPct / 100),
    hardMaxDollar,
  );
  let dollarSize: number;

  if (mode === 'LONG_TERM' && conviction != null) {
    // Conviction-weighted: base allocation * conviction multiplier
    const base = alloc * (config.baseAllocationPct / 100);
    dollarSize = base * convictionMultiplier(conviction);
  } else if (stopLoss && entryPrice && Math.abs(entryPrice - stopLoss) > 0) {
    // Risk-based: risk budget / risk per share
    // Use ALLOCATION cap as base, not portfolio value, to keep trades reasonable
    const riskBudget = alloc * (config.riskPerTradePct / 100);
    const riskPerShare = Math.abs(entryPrice - stopLoss);
    const qty = Math.floor(riskBudget / riskPerShare);
    dollarSize = qty * price;
  } else {
    // Fallback: use flat position size from config
    dollarSize = config.positionSize;
  }

  // Apply regime + Kelly + drawdown multipliers
  dollarSize = dollarSize * regimeMultiplier * kellyMultiplier * drawdownMultiplier;

  // Cap at max position size
  dollarSize = Math.min(dollarSize, maxDollar);

  // Floor
  dollarSize = Math.max(dollarSize, 100); // minimum $100

  const quantity = Math.max(1, Math.floor(dollarSize / price));
  return { quantity, dollarSize: quantity * price };
}

// ── Smart Trading: Drawdown Protection ───────────────────

export interface PortfolioHealth {
  totalUnrealizedPnl: number;
  totalUnrealizedPnlPct: number;
  totalCostBasis: number;
  biggestLoser: { ticker: string; pnl: number; pnlPct: number } | null;
  biggestWinner: { ticker: string; pnl: number; pnlPct: number } | null;
  positionsInLoss: number;
  positionsInGain: number;
  drawdownMultiplier: number;    // 1.0 = normal, 0.5 = half size, 0 = stop trading
  drawdownLevel: 'normal' | 'caution' | 'defensive' | 'critical';
  nearLossCut: { ticker: string; lossPct: number }[];
}

/** Cache health for 5 min to avoid recalculating on every call */
let _healthCache: { data: PortfolioHealth; ts: number } | null = null;
const HEALTH_CACHE_MS = 5 * 60 * 1000;

/**
 * Analyze current portfolio health and determine drawdown protection level.
 *
 * Drawdown levels:
 *   normal:    P&L > -1% → trade at full size
 *   caution:   P&L -1% to -3% → reduce new positions to 75%
 *   defensive: P&L -3% to -5% → reduce new positions to 50%, raise min confidence
 *   critical:  P&L > -5% → STOP all new entries, only manage existing positions
 */
export async function assessPortfolioHealth(config: AutoTraderConfig): Promise<PortfolioHealth> {
  if (_healthCache && Date.now() - _healthCache.ts < HEALTH_CACHE_MS) {
    return _healthCache.data;
  }

  let positions: IBPosition[] = [];
  try {
    positions = await getPositions('');
  } catch {
    // IB not available
  }

  if (positions.length === 0) {
    const neutral: PortfolioHealth = {
      totalUnrealizedPnl: 0, totalUnrealizedPnlPct: 0, totalCostBasis: 0,
      biggestLoser: null, biggestWinner: null,
      positionsInLoss: 0, positionsInGain: 0,
      drawdownMultiplier: 1.0, drawdownLevel: 'normal', nearLossCut: [],
    };
    _healthCache = { data: neutral, ts: Date.now() };
    return neutral;
  }

  let totalPnl = 0;
  let totalCost = 0;
  let biggestLoser: PortfolioHealth['biggestLoser'] = null;
  let biggestWinner: PortfolioHealth['biggestWinner'] = null;
  let inLoss = 0;
  let inGain = 0;
  const nearLossCut: PortfolioHealth['nearLossCut'] = [];

  for (const pos of positions) {
    if (pos.mktPrice <= 0 || pos.avgCost <= 0) continue;
    const costBasis = Math.abs(pos.position) * pos.avgCost;
    const pnl = pos.unrealizedPnl;
    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    totalPnl += pnl;
    totalCost += costBasis;

    if (pnl < 0) {
      inLoss++;
      if (!biggestLoser || pnl < biggestLoser.pnl) {
        biggestLoser = { ticker: pos.contractDesc, pnl, pnlPct };
      }
      // Check if near loss-cut threshold
      const absPct = Math.abs(pnlPct);
      if (absPct >= config.lossCutTier1Pct * 0.6) {
        nearLossCut.push({ ticker: pos.contractDesc, lossPct: absPct });
      }
    } else if (pnl > 0) {
      inGain++;
      if (!biggestWinner || pnl > biggestWinner.pnl) {
        biggestWinner = { ticker: pos.contractDesc, pnl, pnlPct };
      }
    }
  }

  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  // Determine drawdown level
  let drawdownLevel: PortfolioHealth['drawdownLevel'] = 'normal';
  let drawdownMultiplier = 1.0;

  if (totalPnlPct <= -5) {
    drawdownLevel = 'critical';
    drawdownMultiplier = 0; // STOP new entries
  } else if (totalPnlPct <= -3) {
    drawdownLevel = 'defensive';
    drawdownMultiplier = 0.5;
  } else if (totalPnlPct <= -1) {
    drawdownLevel = 'caution';
    drawdownMultiplier = 0.75;
  }

  const health: PortfolioHealth = {
    totalUnrealizedPnl: totalPnl,
    totalUnrealizedPnlPct: totalPnlPct,
    totalCostBasis: totalCost,
    biggestLoser, biggestWinner,
    positionsInLoss: inLoss, positionsInGain: inGain,
    drawdownMultiplier, drawdownLevel, nearLossCut,
  };

  _healthCache = { data: health, ts: Date.now() };

  // Log health summary
  const emoji = drawdownLevel === 'normal' ? 'OK' : drawdownLevel.toUpperCase();
  logEvent('*', drawdownLevel === 'normal' ? 'info' : 'warning',
    `Portfolio health [${emoji}]: ${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}% ($${totalPnl.toFixed(0)}) | ${inGain}W/${inLoss}L` +
    (biggestLoser ? ` | Worst: ${biggestLoser.ticker} ${biggestLoser.pnlPct.toFixed(1)}%` : '') +
    (biggestWinner ? ` | Best: ${biggestWinner.ticker} +${biggestWinner.pnlPct.toFixed(1)}%` : '') +
    (drawdownMultiplier < 1 ? ` | Sizing: ${(drawdownMultiplier * 100).toFixed(0)}%` : '')
  );

  return health;
}

/** Reset health cache (call when positions change) */
export function resetHealthCache() {
  _healthCache = null;
}

// ── Smart Trading: Layer 4a — Market Regime ──────────────

export interface MarketRegime {
  vix: number | null;
  spyPrice: number | null;
  spySma20: number | null;
  multiplier: number;
  label: string;
}

/** Cache regime for 30 min */
let _regimeCache: { data: MarketRegime; ts: number } | null = null;
const REGIME_CACHE_MS = 30 * 60 * 1000;

/** Fetch VIX and SPY data, compute regime multiplier */
export async function getMarketRegime(config: AutoTraderConfig): Promise<MarketRegime> {
  if (!config.marketRegimeEnabled) {
    return { vix: null, spyPrice: null, spySma20: null, multiplier: 1.0, label: 'disabled' };
  }

  // Check cache
  if (_regimeCache && Date.now() - _regimeCache.ts < REGIME_CACHE_MS) {
    return _regimeCache.data;
  }

  let vix: number | null = null;
  let spyPrice: number | null = null;

  try {
    // VIX quote via auto-trader service
    const [vixRes, spyRes] = await Promise.all([
      fetch(`${_IB_BASE}/quote/VIX`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${_IB_BASE}/quote/SPY`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    vix = vixRes?.price ?? null;
    spyPrice = spyRes?.price ?? null;
  } catch {
    // Use defaults
  }

  let multiplier = 1.0;
  let label = 'normal';

  if (vix != null) {
    if (vix > 30) { multiplier = 0.5; label = 'panic'; }
    else if (vix > 25) { multiplier = 0.6; label = 'fear'; }
    else if (vix < 15) { multiplier = 1.1; label = 'complacent'; }
  }

  // SPY trend (simple: if SPY is available, compare to a rough threshold)
  // We don't have SMA20 from the quote endpoint, but we can approximate
  // by checking if price is significantly below recent levels
  const spySma20: number | null = null; // would need historical data

  const regime: MarketRegime = { vix, spyPrice, spySma20, multiplier, label };
  _regimeCache = { data: regime, ts: Date.now() };
  return regime;
}

// ── Smart Trading: Layer 4b — Sector Concentration ───────

/** Cache sector lookups (ticker → sector) for 24h */
const _sectorCache: Map<string, { sector: string; ts: number }> = new Map();
const SECTOR_CACHE_MS = 24 * 60 * 60 * 1000;

/** Fetch sector for a ticker via Finnhub company profile */
async function getTickerSector(ticker: string): Promise<string | null> {
  const cached = _sectorCache.get(ticker.toUpperCase());
  if (cached && Date.now() - cached.ts < SECTOR_CACHE_MS) return cached.sector;

  try {
    const res = await fetch(`${_IB_BASE}/sector/${ticker.toUpperCase()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const sector = data.sector ?? data.finnhubIndustry ?? null;
    if (sector) {
      _sectorCache.set(ticker.toUpperCase(), { sector, ts: Date.now() });
    }
    return sector;
  } catch {
    return null;
  }
}

/**
 * Check if adding a new position in the given ticker's sector would exceed
 * the max sector allocation. Returns true if OK to proceed, false if blocked.
 */
export async function checkSectorExposure(
  config: AutoTraderConfig,
  ticker: string,
  newPositionSize: number,
): Promise<boolean> {
  if (config.maxSectorPct >= 100) return true; // disabled

  const sector = await getTickerSector(ticker);
  if (!sector) return true; // can't determine sector, allow

  // Get all active trades and compute sector exposure
  const trades = await getActiveTrades();
  let sectorExposure = 0;
  for (const t of trades) {
    const tSector = await getTickerSector(t.ticker);
    if (tSector === sector) {
      sectorExposure += t.position_size ?? 0;
    }
  }

  const maxSectorDollar = config.portfolioValue * (config.maxSectorPct / 100);
  if (sectorExposure + newPositionSize > maxSectorDollar) {
    logEvent(ticker, 'warning', `Sector limit: ${sector} at $${sectorExposure.toFixed(0)} + $${newPositionSize.toFixed(0)} > $${maxSectorDollar.toFixed(0)}`);
    persistEvent(ticker, 'warning', `Sector concentration limit reached (${sector})`, {
      action: 'skipped', source: 'system',
      skip_reason: `Sector ${sector} over ${config.maxSectorPct}%`,
      metadata: { sector, sectorExposure, newPositionSize, maxSectorDollar },
    });
    return false;
  }
  return true;
}

// ── Smart Trading: Layer 4c — Earnings Blackout ──────────

/** Cache earnings dates (ticker → next earnings date) for 24h */
const _earningsCache: Map<string, { date: string | null; ts: number }> = new Map();

/** Check if a ticker has earnings within the blackout window */
export async function checkEarningsBlackout(
  config: AutoTraderConfig,
  ticker: string,
): Promise<boolean> {
  if (!config.earningsAvoidEnabled) return true; // disabled, allow

  const cached = _earningsCache.get(ticker.toUpperCase());
  if (cached && Date.now() - cached.ts < SECTOR_CACHE_MS) {
    if (!cached.date) return true; // no earnings date found
    const daysUntil = (new Date(cached.date).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysUntil >= 0 && daysUntil <= config.earningsBlackoutDays) {
      logEvent(ticker, 'warning', `Earnings in ${daysUntil.toFixed(0)} days — blackout`);
      persistEvent(ticker, 'warning', `Earnings blackout: ${daysUntil.toFixed(0)} days until earnings`, {
        action: 'skipped', source: 'system',
        skip_reason: `Earnings within ${config.earningsBlackoutDays} days`,
        metadata: { earningsDate: cached.date, daysUntil },
      });
      return false;
    }
    return true;
  }

  try {
    const res = await fetch(`${_IB_BASE}/earnings/${ticker.toUpperCase()}`);
    if (!res.ok) {
      _earningsCache.set(ticker.toUpperCase(), { date: null, ts: Date.now() });
      return true;
    }
    const data = await res.json();
    const earningsDate = data.earningsDate ?? null;
    _earningsCache.set(ticker.toUpperCase(), { date: earningsDate, ts: Date.now() });

    if (earningsDate) {
      const daysUntil = (new Date(earningsDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      if (daysUntil >= 0 && daysUntil <= config.earningsBlackoutDays) {
        logEvent(ticker, 'warning', `Earnings on ${earningsDate} (${daysUntil.toFixed(0)} days) — blackout`);
        persistEvent(ticker, 'warning', `Earnings blackout: ${earningsDate}`, {
          action: 'skipped', source: 'system',
          skip_reason: `Earnings within ${config.earningsBlackoutDays} days`,
          metadata: { earningsDate, daysUntil },
        });
        return false;
      }
    }
    return true;
  } catch {
    return true; // can't check, allow
  }
}

// ── Smart Trading: Layer 4d — Half-Kelly Adaptive ────────

import { getPerformance } from './paperTradesApi';

/**
 * Calculate the Half-Kelly multiplier from actual trade history.
 * Returns a multiplier between 0.25 and 2.0 (clamped for safety).
 * Returns 1.0 if insufficient data or Kelly is disabled.
 */
export async function calculateKellyMultiplier(config: AutoTraderConfig): Promise<number> {
  if (!config.kellyAdaptiveEnabled) return 1.0;

  const perf = await getPerformance();
  if (!perf || perf.total_trades < 10) return 1.0; // insufficient data

  const winRate = (perf.win_rate ?? 0) / 100; // convert from % to decimal
  const avgWin = Math.abs(perf.avg_win ?? 0);
  const avgLoss = Math.abs(perf.avg_loss ?? 1);

  if (avgWin <= 0 || avgLoss <= 0) return 1.0;

  // Kelly fraction: f = (winRate * avgWin - (1-winRate) * avgLoss) / avgWin
  const kelly = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin;

  // Half-Kelly for safety
  const halfKelly = kelly / 2;

  // Clamp between 0.25 and 2.0
  return Math.max(0.25, Math.min(2.0, halfKelly));
}

// ── Smart Trading: Layer 2 — Dip Buying ──────────────────

import type { IBPosition } from './ibClient';

/**
 * Check all long-term positions for dip-buy opportunities.
 * Buys more shares when price drops below avgCost by tier thresholds.
 */
export async function checkDipBuyOpportunities(
  config: AutoTraderConfig,
  ibPositions: IBPosition[],
): Promise<ProcessResult[]> {
  if (!config.dipBuyEnabled || !config.accountId) return [];

  const results: ProcessResult[] = [];
  const activeTrades = await getActiveTrades();
  const longTermFilled = activeTrades.filter(t => t.mode === 'LONG_TERM' && t.status === 'FILLED');

  const tiers = [
    { pct: config.dipBuyTier3Pct, sizePct: config.dipBuyTier3SizePct, label: 'Tier 3' },
    { pct: config.dipBuyTier2Pct, sizePct: config.dipBuyTier2SizePct, label: 'Tier 2' },
    { pct: config.dipBuyTier1Pct, sizePct: config.dipBuyTier1SizePct, label: 'Tier 1' },
  ];

  for (const trade of longTermFilled) {
    const ibPos = ibPositions.find(p => p.contractDesc.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const dipPct = ((ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost) * 100;
    if (dipPct >= 0) continue; // not a dip
    const absDip = Math.abs(dipPct);

    // Find highest triggered tier
    const triggered = tiers.find(t => absDip >= t.pct);
    if (!triggered) continue;

    // Cooldown check: no dip buy for this ticker in last N hours
    const cooldownMs = config.dipBuyCooldownHours * 60 * 60 * 1000;
    const { data: recentDipBuys } = await supabase
      .from('auto_trade_events')
      .select('created_at')
      .eq('ticker', trade.ticker)
      .eq('source', 'dip_buy')
      .eq('action', 'executed')
      .order('created_at', { ascending: false })
      .limit(1);

    if (recentDipBuys && recentDipBuys.length > 0) {
      const lastBuyTime = new Date(recentDipBuys[0].created_at).getTime();
      if (Date.now() - lastBuyTime < cooldownMs) {
        logEvent(trade.ticker, 'info', `Dip buy cooldown active (${config.dipBuyCooldownHours}h)`);
        continue;
      }
    }

    // Max position check — use the tighter of portfolio% or 10% of allocation
    const currentPositionValue = Math.abs(ibPos.position) * ibPos.mktPrice;
    const maxPositionValue = Math.min(
      config.portfolioValue * (config.maxPositionPct / 100),
      config.maxTotalAllocation * 0.10,
    );
    if (currentPositionValue >= maxPositionValue) {
      logEvent(trade.ticker, 'info', `Position already at max ($${maxPositionValue.toFixed(0)} cap)`);
      continue;
    }

    // Allocation cap check
    const originalQty = trade.quantity ?? Math.abs(ibPos.position);
    const addOnQty = Math.max(1, Math.floor(originalQty * (triggered.sizePct / 100)));
    const addOnDollar = addOnQty * ibPos.mktPrice;

    const capOk = await checkAllocationCap(config, addOnDollar, trade.ticker);
    if (!capOk) continue;

    // Place dip buy
    logEvent(trade.ticker, 'info', `Dip buy ${triggered.label}: ${addOnQty} shares at -${absDip.toFixed(1)}%`);

    try {
      const contract = await searchContract(trade.ticker);
      if (!contract) continue;

      const orderReplies = await placeMarketOrder({
        accountId: config.accountId,
        conid: contract.conid,
        side: 'BUY',
        quantity: addOnQty,
        symbol: trade.ticker,
      });
      await handleOrderConfirmations(orderReplies);
      const orderId = orderReplies[0]?.order_id ?? null;

      await createPaperTrade({
        ticker: trade.ticker,
        mode: 'LONG_TERM',
        signal: 'BUY',
        scanner_confidence: trade.scanner_confidence,
        fa_confidence: trade.fa_confidence,
        fa_recommendation: 'BUY',
        entry_price: ibPos.mktPrice,
        quantity: addOnQty,
        position_size: addOnDollar,
        ib_order_id: orderId,
        status: 'SUBMITTED',
        notes: `Dip buy ${triggered.label} at -${absDip.toFixed(1)}% | Added ${addOnQty} shares`,
      });

      // Track pending order for allocation cap enforcement
      recordPendingOrder(trade.ticker, addOnDollar);

      const msg = `Dip buy ${triggered.label}: +${addOnQty} shares at $${ibPos.mktPrice.toFixed(2)} (-${absDip.toFixed(1)}%)`;
      logEvent(trade.ticker, 'success', msg);
      persistEvent(trade.ticker, 'success', msg, {
        action: 'executed', source: 'dip_buy', mode: 'LONG_TERM',
        scanner_signal: 'BUY', scanner_confidence: trade.scanner_confidence ?? undefined,
        metadata: { tier: triggered.label, dipPct: absDip, addOnQty, addOnDollar, mktPrice: ibPos.mktPrice },
      });

      results.push({ ticker: trade.ticker, action: 'executed', reason: `Dip buy ${triggered.label}` });
    } catch (err) {
      const msg = `Dip buy failed: ${err instanceof Error ? err.message : 'Unknown'}`;
      logEvent(trade.ticker, 'error', msg);
      persistEvent(trade.ticker, 'error', msg, {
        action: 'failed', source: 'dip_buy', mode: 'LONG_TERM',
        skip_reason: 'Dip buy order failed',
        metadata: { tier: triggered.label, dipPct: absDip },
      });
      results.push({ ticker: trade.ticker, action: 'failed', reason: msg });
    }
  }

  return results;
}

// ── Smart Trading: Layer 3 — Profit Taking ───────────────

/**
 * Check all long-term positions for profit-taking opportunities.
 * Trims positions when gains exceed tier thresholds.
 */
export async function checkProfitTakeOpportunities(
  config: AutoTraderConfig,
  ibPositions: IBPosition[],
): Promise<ProcessResult[]> {
  if (!config.profitTakeEnabled || !config.accountId) return [];

  const results: ProcessResult[] = [];
  const activeTrades = await getActiveTrades();
  const longTermFilled = activeTrades.filter(t => t.mode === 'LONG_TERM' && t.status === 'FILLED');

  const tiers = [
    { pct: config.profitTakeTier3Pct, trimPct: config.profitTakeTier3TrimPct, label: 'Tier 3' },
    { pct: config.profitTakeTier2Pct, trimPct: config.profitTakeTier2TrimPct, label: 'Tier 2' },
    { pct: config.profitTakeTier1Pct, trimPct: config.profitTakeTier1TrimPct, label: 'Tier 1' },
  ];

  for (const trade of longTermFilled) {
    const ibPos = ibPositions.find(p => p.contractDesc.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const gainPct = ((ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost) * 100;
    if (gainPct <= 0) continue; // no gain

    // Find highest triggered tier
    const triggered = tiers.find(t => gainPct >= t.pct);
    if (!triggered) continue;

    // Check if we already trimmed at this tier
    const { data: pastTrimEvents } = await supabase
      .from('auto_trade_events')
      .select('metadata')
      .eq('ticker', trade.ticker)
      .eq('source', 'profit_take')
      .eq('action', 'executed');

    const alreadyTrimmedAtTier = pastTrimEvents?.some(
      e => (e.metadata as Record<string, unknown>)?.tier === triggered.label
    );
    if (alreadyTrimmedAtTier) continue;

    // Min hold check
    const originalQty = trade.quantity ?? Math.abs(ibPos.position);
    const currentQty = Math.abs(ibPos.position);
    const minHoldQty = Math.ceil(originalQty * (config.minHoldPct / 100));
    const trimQty = Math.max(1, Math.floor(currentQty * (triggered.trimPct / 100)));

    if (currentQty - trimQty < minHoldQty) {
      const adjustedTrim = currentQty - minHoldQty;
      if (adjustedTrim < 1) {
        logEvent(trade.ticker, 'info', `Can't trim: would go below ${config.minHoldPct}% min hold`);
        continue;
      }
    }

    const actualTrimQty = Math.min(trimQty, currentQty - minHoldQty);
    if (actualTrimQty < 1) continue;

    const trimDollar = actualTrimQty * ibPos.mktPrice;

    // Place sell order
    logEvent(trade.ticker, 'info', `Profit take ${triggered.label}: selling ${actualTrimQty} shares at +${gainPct.toFixed(1)}%`);

    try {
      const contract = await searchContract(trade.ticker);
      if (!contract) continue;

      const orderReplies = await placeMarketOrder({
        accountId: config.accountId,
        conid: contract.conid,
        side: 'SELL',
        quantity: actualTrimQty,
        symbol: trade.ticker,
      });
      await handleOrderConfirmations(orderReplies);
      const orderId = orderReplies[0]?.order_id ?? null;

      // Log as a separate "partial sell" trade record
      await createPaperTrade({
        ticker: trade.ticker,
        mode: 'LONG_TERM',
        signal: 'SELL',
        scanner_confidence: trade.scanner_confidence,
        fa_confidence: trade.fa_confidence,
        fa_recommendation: 'SELL',
        entry_price: ibPos.mktPrice,
        quantity: actualTrimQty,
        position_size: trimDollar,
        ib_order_id: orderId,
        status: 'SUBMITTED',
        notes: `Profit take ${triggered.label} at +${gainPct.toFixed(1)}% | Sold ${actualTrimQty} of ${currentQty} shares`,
      });

      const msg = `Profit take ${triggered.label}: sold ${actualTrimQty} shares at $${ibPos.mktPrice.toFixed(2)} (+${gainPct.toFixed(1)}%)`;
      logEvent(trade.ticker, 'success', msg);
      persistEvent(trade.ticker, 'success', msg, {
        action: 'executed', source: 'profit_take', mode: 'LONG_TERM',
        scanner_signal: 'SELL', scanner_confidence: trade.scanner_confidence ?? undefined,
        metadata: { tier: triggered.label, gainPct, trimQty: actualTrimQty, trimDollar, mktPrice: ibPos.mktPrice },
      });

      results.push({ ticker: trade.ticker, action: 'executed', reason: `Profit take ${triggered.label}` });
    } catch (err) {
      const msg = `Profit take failed: ${err instanceof Error ? err.message : 'Unknown'}`;
      logEvent(trade.ticker, 'error', msg);
      persistEvent(trade.ticker, 'error', msg, {
        action: 'failed', source: 'profit_take', mode: 'LONG_TERM',
        skip_reason: 'Profit take order failed',
        metadata: { tier: triggered.label, gainPct },
      });
      results.push({ ticker: trade.ticker, action: 'failed', reason: msg });
    }
  }

  return results;
}

// ── Smart Trading: Layer 3b — Loss Cutting ────────────────

/**
 * Check all long-term positions for loss-cutting.
 * Sells positions when losses exceed tier thresholds to protect capital.
 * Only acts on positions held longer than lossCutMinHoldDays.
 */
export async function checkLossCutOpportunities(
  config: AutoTraderConfig,
  ibPositions: IBPosition[],
): Promise<ProcessResult[]> {
  if (!config.lossCutEnabled || !config.accountId) return [];

  const results: ProcessResult[] = [];
  const activeTrades = await getActiveTrades();
  // Apply to ALL active positions (long-term, swing, filled/partial)
  const eligibleTrades = activeTrades.filter(t =>
    (t.mode === 'LONG_TERM' || t.mode === 'SWING_TRADE') &&
    (t.status === 'FILLED' || t.status === 'PARTIAL')
  );

  const tiers = [
    { pct: config.lossCutTier3Pct, sellPct: config.lossCutTier3SellPct, label: 'Tier 3 (full exit)' },
    { pct: config.lossCutTier2Pct, sellPct: config.lossCutTier2SellPct, label: 'Tier 2' },
    { pct: config.lossCutTier1Pct, sellPct: config.lossCutTier1SellPct, label: 'Tier 1' },
  ];

  for (const trade of eligibleTrades) {
    const ibPos = ibPositions.find(p => p.contractDesc.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const lossPct = ((ibPos.avgCost - ibPos.mktPrice) / ibPos.avgCost) * 100;
    if (lossPct <= 0) continue; // not in a loss

    // Min hold period check — don't cut on intraday noise
    if (trade.created_at) {
      const createdAt = new Date(trade.created_at).getTime();
      const holdDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
      if (holdDays < config.lossCutMinHoldDays) {
        continue;
      }
    }

    // Find highest triggered tier
    const triggered = tiers.find(t => lossPct >= t.pct);
    if (!triggered) continue;

    // Check if we already cut at this tier
    const { data: pastCutEvents } = await supabase
      .from('auto_trade_events')
      .select('metadata')
      .eq('ticker', trade.ticker)
      .eq('source', 'loss_cut')
      .eq('action', 'executed');

    const alreadyCutAtTier = pastCutEvents?.some(
      e => (e.metadata as Record<string, unknown>)?.tier === triggered.label
    );
    if (alreadyCutAtTier) continue;

    const currentQty = Math.abs(ibPos.position);
    const sellQty = triggered.sellPct >= 100
      ? currentQty
      : Math.max(1, Math.floor(currentQty * (triggered.sellPct / 100)));

    if (sellQty < 1) continue;

    const sellDollar = sellQty * ibPos.mktPrice;

    logEvent(trade.ticker, 'info', `Loss cut ${triggered.label}: selling ${sellQty} shares at -${lossPct.toFixed(1)}%`);

    try {
      const contract = await searchContract(trade.ticker);
      if (!contract) continue;

      const side = ibPos.position > 0 ? 'SELL' : 'BUY'; // close the position direction
      const orderReplies = await placeMarketOrder({
        accountId: config.accountId,
        conid: contract.conid,
        side,
        quantity: sellQty,
        symbol: trade.ticker,
      });
      await handleOrderConfirmations(orderReplies);
      const orderId = orderReplies[0]?.order_id ?? null;

      await createPaperTrade({
        ticker: trade.ticker,
        mode: trade.mode as 'LONG_TERM' | 'SWING_TRADE',
        signal: 'SELL',
        scanner_confidence: trade.scanner_confidence,
        fa_confidence: trade.fa_confidence,
        fa_recommendation: 'SELL',
        entry_price: ibPos.mktPrice,
        quantity: sellQty,
        position_size: sellDollar,
        ib_order_id: orderId,
        status: 'SUBMITTED',
        notes: `Loss cut ${triggered.label} at -${lossPct.toFixed(1)}% | Sold ${sellQty} of ${currentQty} shares`,
      });

      const realizedLoss = sellQty * (ibPos.mktPrice - ibPos.avgCost);
      const msg = `Loss cut ${triggered.label}: sold ${sellQty} shares at $${ibPos.mktPrice.toFixed(2)} (-${lossPct.toFixed(1)}%, ~${fmtUsdSimple(realizedLoss)})`;
      logEvent(trade.ticker, 'success', msg);
      persistEvent(trade.ticker, 'success', msg, {
        action: 'executed', source: 'loss_cut', mode: trade.mode as 'LONG_TERM',
        scanner_signal: 'SELL', scanner_confidence: trade.scanner_confidence ?? undefined,
        metadata: { tier: triggered.label, lossPct, sellQty, sellDollar, mktPrice: ibPos.mktPrice, realizedLoss },
      });

      results.push({ ticker: trade.ticker, action: 'executed', reason: `Loss cut ${triggered.label}` });
    } catch (err) {
      const msg = `Loss cut failed: ${err instanceof Error ? err.message : 'Unknown'}`;
      logEvent(trade.ticker, 'error', msg);
      persistEvent(trade.ticker, 'error', msg, {
        action: 'failed', source: 'loss_cut', mode: trade.mode as 'LONG_TERM',
        skip_reason: 'Loss cut order failed',
        metadata: { tier: triggered.label, lossPct },
      });
      results.push({ ticker: trade.ticker, action: 'failed', reason: msg });
    }
  }

  return results;
}

/** Simple USD format for log messages */
function fmtUsdSimple(val: number): string {
  const sign = val >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toFixed(0)}`;
}

// ── Smart Trading: Pre-Trade Checks ──────────────────────

/**
 * Run all pre-trade checks (allocation cap, sector limits, earnings blackout).
 * Returns true if the trade is allowed, false if blocked.
 */
async function runPreTradeChecks(
  config: AutoTraderConfig,
  ticker: string,
  positionSize: number,
): Promise<boolean> {
  // 0. Drawdown protection — block new entries when portfolio is in critical drawdown
  const health = await assessPortfolioHealth(config);
  if (health.drawdownLevel === 'critical') {
    const msg = `DRAWDOWN PROTECTION: Portfolio at ${health.totalUnrealizedPnlPct.toFixed(1)}% — blocking all new entries`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'system',
      skip_reason: 'Critical drawdown — no new entries',
      metadata: { drawdownLevel: health.drawdownLevel, pnlPct: health.totalUnrealizedPnlPct },
    });
    return false;
  }

  // 1. Allocation cap
  const capOk = await checkAllocationCap(config, positionSize, ticker);
  if (!capOk) return false;

  // 2. Sector limits
  const sectorOk = await checkSectorExposure(config, ticker, positionSize);
  if (!sectorOk) return false;

  // 3. Earnings blackout
  const earningsOk = await checkEarningsBlackout(config, ticker);
  if (!earningsOk) return false;

  return true;
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

  // ── 6. Dynamic Position Sizing ──
  const regime = await getMarketRegime(config);
  const kellyMult = await calculateKellyMultiplier(config);
  const health = await assessPortfolioHealth(config);
  const sizing = calculatePositionSize(config, {
    price: entryPrice,
    mode,
    entryPrice,
    stopLoss,
    regimeMultiplier: regime.multiplier,
    kellyMultiplier: kellyMult,
    drawdownMultiplier: health.drawdownMultiplier,
  });
  const quantity = sizing.quantity;

  if (quantity < 1) {
    const msg = `Position size too small: $${sizing.dollarSize.toFixed(0)} / $${entryPrice} < 1 share`;
    logEvent(ticker, 'warning', msg);
    persistEvent(ticker, 'warning', msg, {
      action: 'skipped', source: 'scanner', mode, scanner_signal: signal,
      scanner_confidence: scannerConf, fa_recommendation: faRec, fa_confidence: faConf,
      skip_reason: 'Position size too small for 1 share',
    });
    return { ticker, action: 'skipped', reason: 'Position size too small for 1 share' };
  }

  // ── 6b. Pre-trade checks (allocation cap, sector limits, earnings blackout) ──
  const preCheckOk = await runPreTradeChecks(config, ticker, sizing.dollarSize);
  if (!preCheckOk) {
    return { ticker, action: 'skipped', reason: 'Pre-trade check failed (allocation/sector/earnings)' };
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
      in_play_score: idea.in_play_score,
      pass1_confidence: idea.pass1_confidence,
      entry_trigger_type: 'bracket_limit',
      market_condition: idea.market_condition,
    });

    // Track pending order for allocation cap enforcement
    recordPendingOrder(ticker, quantity * entryPrice);

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
 * These are long-term positions: always LONG_TERM mode, GTC orders.
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

/** Process a single Suggested Find stock — verifies conviction freshness, then long-term buy */
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
      action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'Duplicate position', metadata: sfMeta,
    });
    return { ticker, action: 'skipped', reason: 'Duplicate position' };
  }

  // ── 2. Fresh conviction verification ──
  // Run a quick swing analysis to verify the AI still recommends this stock.
  // Prevents buying a stock where cached conviction is 9 but real-time says 6.
  try {
    logEvent(ticker, 'info', `${source} — verifying conviction (cached: ${conviction}/10)...`);
    const freshFA = await fetchTradingSignal(ticker, 'SWING_TRADE');
    const freshConf = freshFA.trade?.confidence ?? 0;
    const freshRec = freshFA.trade?.recommendation ?? 'HOLD';
    const convDrop = conviction - freshConf;

    if (freshRec === 'SELL') {
      const msg = `Conviction verification FAILED: FA says SELL (conf ${freshConf}) — skipping ${source}`;
      logEvent(ticker, 'warning', msg);
      persistEvent(ticker, 'warning', msg, {
        action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
        scanner_signal: 'BUY', scanner_confidence: conviction,
        fa_recommendation: freshRec, fa_confidence: freshConf,
        skip_reason: 'Fresh FA says SELL', metadata: { ...sfMeta, fresh_confidence: freshConf, conviction_drop: convDrop },
      });
      return { ticker, action: 'skipped', reason: `Fresh FA says SELL (conf ${freshConf})` };
    }

    if (convDrop >= 3) {
      const msg = `Conviction dropped ${convDrop} points (cached: ${conviction} → fresh: ${freshConf}) — skipping ${source}`;
      logEvent(ticker, 'warning', msg);
      persistEvent(ticker, 'warning', msg, {
        action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
        scanner_signal: 'BUY', scanner_confidence: conviction,
        fa_recommendation: freshRec, fa_confidence: freshConf,
        skip_reason: `Conviction dropped ${convDrop}pts`, metadata: { ...sfMeta, fresh_confidence: freshConf, conviction_drop: convDrop },
      });
      return { ticker, action: 'skipped', reason: `Conviction dropped ${convDrop}pts (${conviction}→${freshConf})` };
    }

    logEvent(ticker, 'info', `Conviction verified: ${freshRec}/${freshConf} (cached: ${conviction}, drop: ${convDrop}) — proceeding`);
  } catch (err) {
    // If verification fails (API error), proceed with cached conviction — don't block the trade
    logEvent(ticker, 'warning', `Conviction verification failed (${err instanceof Error ? err.message : 'unknown'}) — using cached conviction ${conviction}`);
  }

  // ── 3. Get current price for position sizing ──
  logEvent(ticker, 'info', `${source} — conviction ${conviction}/10, buying at market (long-term hold)`);

  const currentPrice = await getQuotePrice(ticker);
  if (!currentPrice) {
    const msg = `Could not fetch current price for ${source}`;
    logEvent(ticker, 'error', msg);
    persistEvent(ticker, 'error', msg, {
      action: 'failed', source: 'suggested_finds', mode: 'LONG_TERM',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'Price lookup failed', metadata: sfMeta,
    });
    return { ticker, action: 'failed', reason: 'Price lookup failed' };
  }

  // Dynamic position sizing for long-term holds
  const regime = await getMarketRegime(config);
  const kellyMult = await calculateKellyMultiplier(config);
  const health = await assessPortfolioHealth(config);
  const sizing = calculatePositionSize(config, {
    price: currentPrice,
    mode: 'LONG_TERM',
    conviction,
    regimeMultiplier: regime.multiplier,
    kellyMultiplier: kellyMult,
    drawdownMultiplier: health.drawdownMultiplier,
  });
  const quantity = sizing.quantity;

  // Pre-trade checks (allocation cap, sector limits, earnings blackout)
  const preCheckOk = await runPreTradeChecks(config, ticker, sizing.dollarSize);
  if (!preCheckOk) {
    return { ticker, action: 'skipped', reason: 'Pre-trade check failed (allocation/sector/earnings)' };
  }

  // ── 4. Search IB Contract ──
  const contract = await searchContract(ticker);
  if (!contract) {
    logEvent(ticker, 'error', `Stock not found on IB (${source})`);
    persistEvent(ticker, 'error', `Stock not found on IB (${source})`, {
      action: 'failed', source: 'suggested_finds', mode: 'LONG_TERM',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'IB contract not found', metadata: sfMeta,
    });
    return { ticker, action: 'failed', reason: 'IB contract not found' };
  }

  // ── 5. Place Market Buy (no bracket — long-term hold, no stop loss/target) ──
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

    // ── 6. Log Trade ──
    const trade = await createPaperTrade({
      ticker,
      mode: 'LONG_TERM',
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

    // Track pending order for allocation cap enforcement
    recordPendingOrder(ticker, quantity * currentPrice);

    const msg = `${source} market BUY placed! ${quantity} shares of ${ticker} @ ~$${currentPrice.toFixed(2)}`;
    logEvent(ticker, 'success', msg);
    persistEvent(ticker, 'success', msg, {
      action: 'executed', source: 'suggested_finds', mode: 'LONG_TERM',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      fa_recommendation: 'BUY', fa_confidence: conviction,
      metadata: { ...sfMeta, current_price: currentPrice, quantity, order_type: 'MARKET' },
    });
    return { ticker, action: 'executed', reason: 'Market order placed successfully', trade };
  } catch (err) {
    const msg = `Order failed for ${source}: ${err instanceof Error ? err.message : 'Unknown'}`;
    logEvent(ticker, 'error', msg);
    persistEvent(ticker, 'error', msg, {
      action: 'failed', source: 'suggested_finds', mode: 'LONG_TERM',
      scanner_signal: 'BUY', scanner_confidence: conviction,
      skip_reason: 'Order rejected by IB', metadata: sfMeta,
    });

    await createPaperTrade({
      ticker,
      mode: 'LONG_TERM',
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

        let rMultiple: number | null = null;
        if (trade.stop_loss != null && trade.entry_price != null && trade.entry_price !== trade.stop_loss) {
          const riskPerShare = Math.abs(trade.entry_price - trade.stop_loss);
          rMultiple = isLong
            ? (actualClosePrice - fillPrice) / riskPerShare
            : (fillPrice - actualClosePrice) / riskPerShare;
          rMultiple = parseFloat(rMultiple.toFixed(2));
        }

        await updatePaperTrade(trade.id, {
          status: status as PaperTrade['status'],
          close_reason: closeReason,
          close_price: actualClosePrice,
          closed_at: new Date().toISOString(),
          pnl: parseFloat(pnl.toFixed(2)),
          pnl_percent: fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null,
          r_multiple: rMultiple,
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
