/**
 * IB Gateway connection manager using @stoqey/ib (TWS API).
 *
 * - Auto-connects to IB Gateway on port 4002 (paper trading)
 * - Auto-reconnects on disconnect with exponential backoff
 * - Exposes connection state + account info to REST routes
 */

import { IBApi, EventName, Contract, Order, OrderAction, OrderType, SecType, TimeInForce, OptionType } from '@stoqey/ib';
import { insertIbFill, updateIbFillCommission, getTodayFillPrices } from './lib/supabase.js';

// ── Configuration ────────────────────────────────────────

const IB_HOST = process.env.IB_HOST ?? '127.0.0.1';
const IB_PORT = parseInt(process.env.IB_PORT ?? '4002', 10);
const IB_CLIENT_ID = parseInt(process.env.IB_CLIENT_ID ?? '1', 10);

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_CONCURRENT_REQUESTS = 8;

// ── State ────────────────────────────────────────────────

let ib: IBApi | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let accounts: string[] = [];
let nextOrderId = 0;
let connectionListeners: Array<(state: boolean) => void> = [];

// ── Account-level daily P&L (via reqPnL subscription) ───
let _pnlReqId = 0;
let _dailyPnL: number | null = null;
let _unrealizedPnL: number | null = null;
let _realizedPnL: number | null = null;

// ── Order fill prices (from orderStatus events) ─────────
// Maps orderId → avgFillPrice. Populated when IB reports a Filled status.
const _orderFillPrices = new Map<number, number>();

// Per-request error routing: when IB sends error code 200 for a specific reqId,
// resolve the pending promise immediately instead of waiting for timeout.
const _pendingReqCallbacks = new Map<number, (code: number, msg: string) => void>();

// Pending order callbacks: resolves/rejects order promises when IB sends
// fill confirmation (orderStatus Filled) or rejection (error/Cancelled/Inactive).
// Prevents the fire-and-forget bug where callers assumed success without confirmation.
interface PendingOrder {
  resolve: (result: { orderId: number; avgFillPrice: number; filledQty: number }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  symbol: string;
}
const _pendingOrderCallbacks = new Map<number, PendingOrder>();

// Semaphore to limit concurrent IB API requests and prevent flooding
let _activeRequests = 0;
const _requestQueue: Array<() => void> = [];

export async function acquireRequestSlot(): Promise<void> {
  if (_activeRequests < MAX_CONCURRENT_REQUESTS) {
    _activeRequests++;
    return;
  }
  return new Promise<void>(resolve => {
    _requestQueue.push(() => { _activeRequests++; resolve(); });
  });
}

export function releaseRequestSlot(): void {
  _activeRequests--;
  const next = _requestQueue.shift();
  if (next) next();
}

export function registerReqErrorCallback(reqId: number, cb: (code: number, msg: string) => void): void {
  _pendingReqCallbacks.set(reqId, cb);
}

export function unregisterReqErrorCallback(reqId: number): void {
  _pendingReqCallbacks.delete(reqId);
}

// ── Public API ───────────────────────────────────────────

export function isConnected(): boolean {
  return connected;
}

export function getAccounts(): string[] {
  return accounts;
}

export function getDefaultAccount(): string | null {
  return accounts[0] ?? null;
}

export function getIBApi(): IBApi | null {
  return ib;
}

export function getNextOrderId(): number {
  return nextOrderId++;
}

export function onConnectionChange(fn: (state: boolean) => void): () => void {
  connectionListeners.push(fn);
  return () => {
    connectionListeners = connectionListeners.filter(l => l !== fn);
  };
}

export interface AccountPnL {
  dailyPnL: number | null;
  unrealizedPnL: number | null;
  realizedPnL: number | null;
}

export function getDailyPnL(): AccountPnL {
  return { dailyPnL: _dailyPnL, unrealizedPnL: _unrealizedPnL, realizedPnL: _realizedPnL };
}

/**
 * Get the actual IB fill price for an order from the in-memory cache.
 * For a DB fallback when the cache misses, use getOrderFillPriceWithFallback().
 */
export function getOrderFillPrice(orderId: number): number | undefined {
  return _orderFillPrices.get(orderId);
}

/**
 * Get fill price with DB fallback. Use this in non-hot paths where an async
 * call is acceptable (e.g. syncPositions closure logic).
 */
export async function getOrderFillPriceWithFallback(orderId: number): Promise<number | undefined> {
  const cached = _orderFillPrices.get(orderId);
  if (cached !== undefined) return cached;
  const { getFillPriceByOrderId } = await import('./lib/supabase.js');
  const dbPrice = await getFillPriceByOrderId(orderId);
  if (dbPrice !== undefined) {
    _orderFillPrices.set(orderId, dbPrice);
  }
  return dbPrice;
}

/**
 * Hydrate the in-memory fill price cache from the ib_fills DB table.
 * Called on startup to survive restarts.
 */
async function hydrateOrderFillPrices(): Promise<void> {
  try {
    const fills = await getTodayFillPrices();
    let count = 0;
    for (const [orderId, price] of fills) {
      if (!_orderFillPrices.has(orderId)) {
        _orderFillPrices.set(orderId, price);
        count++;
      }
    }
    if (count > 0) {
      console.log(`[IB] Hydrated ${count} fill prices from DB`);
    }
  } catch (err) {
    console.warn('[IB] Failed to hydrate fill prices from DB:', err instanceof Error ? err.message : err);
  }
}

// ── Connect ──────────────────────────────────────────────

export function connect(): void {
  if (ib) {
    try { ib.disconnect(); } catch { /* ignore */ }
  }

  ib = new IBApi({ host: IB_HOST, port: IB_PORT, clientId: IB_CLIENT_ID });

  // ── Event handlers ──

  ib.on(EventName.connected, () => {
    console.log(`[IB] Connected to IB Gateway at ${IB_HOST}:${IB_PORT}`);
    connected = true;
    reconnectAttempts = 0;
    connectionListeners.forEach(fn => fn(true));

    // Request managed accounts
    ib!.reqManagedAccts();
    // Request next valid order ID
    ib!.reqIds();
  });

  ib.on(EventName.disconnected, () => {
    console.log('[IB] Disconnected from IB Gateway');
    connected = false;
    connectionListeners.forEach(fn => fn(false));
    scheduleReconnect();
  });

  ib.on(EventName.error, (err: Error, code?: number, reqId?: number) => {
    // Code 1100 = connectivity lost, 1102 = connectivity restored
    // Code 2104/2106/2158 = market data farm messages (informational)
    const infoOnly = code && [2104, 2106, 2108, 2158].includes(code);
    if (infoOnly) {
      console.log(`[IB] Info (${code}): ${err.message}`);
      return;
    }

    // Route per-request errors (e.g. code 200 "No security definition") to the
    // waiting promise so it resolves immediately instead of waiting for timeout.
    if (reqId != null && code != null && _pendingReqCallbacks.has(reqId)) {
      const cb = _pendingReqCallbacks.get(reqId)!;
      _pendingReqCallbacks.delete(reqId);
      cb(code, err.message);
      return;
    }

    // Route order-level errors (code 200 = no security def, 201 = rejected,
    // 202 = cancelled, 110 = price cap, etc.) to the pending order promise.
    if (reqId != null && _pendingOrderCallbacks.has(reqId)) {
      const pending = _pendingOrderCallbacks.get(reqId)!;
      clearTimeout(pending.timer);
      _pendingOrderCallbacks.delete(reqId);
      const msg = `IB order ${reqId} (${pending.symbol}) rejected: code=${code} ${err.message}`;
      console.error(`[IB] ${msg}`);
      pending.reject(new Error(msg));
      return;
    }

    console.error(`[IB] Error (code=${code}, reqId=${reqId}): ${err.message}`);

    if (code === 1100) {
      connected = false;
      connectionListeners.forEach(fn => fn(false));
    }
  });

  ib.on(EventName.managedAccounts, (accountsList: string) => {
    accounts = accountsList.split(',').map(a => a.trim()).filter(Boolean);
    console.log(`[IB] Managed accounts: ${accounts.join(', ')}`);

    // Subscribe to account-level daily P&L once we have the account ID
    if (accounts[0] && ib) {
      _pnlReqId = getNextOrderId();
      _dailyPnL = null;
      _unrealizedPnL = null;
      _realizedPnL = null;
      try {
        ib.reqPnL(_pnlReqId, accounts[0], '');
        console.log(`[IB] Subscribed to account PnL (reqId=${_pnlReqId}, account=${accounts[0]})`);
      } catch (err) {
        console.warn(`[IB] reqPnL failed:`, err instanceof Error ? err.message : err);
      }
    }
  });

  ib.on(EventName.nextValidId, (orderId: number) => {
    nextOrderId = orderId;
    console.log(`[IB] Next valid order ID: ${nextOrderId}`);
  });

  ib.on(EventName.pnl, (reqId: number, dailyPnL: number, unrealizedPnL?: number, realizedPnL?: number) => {
    if (reqId !== _pnlReqId) return;
    _dailyPnL = dailyPnL;
    _unrealizedPnL = unrealizedPnL ?? null;
    _realizedPnL = realizedPnL ?? null;
  });

  ib.on(EventName.orderStatus, (
    orderId: number, status: string, filled: number,
    _remaining: number, avgFillPrice: number,
  ) => {
    if (status === 'Filled' && avgFillPrice > 0) {
      _orderFillPrices.set(orderId, avgFillPrice);
      console.log(`[IB] Order ${orderId} filled @ $${avgFillPrice.toFixed(4)}`);

      // Resolve the pending order promise with fill confirmation
      if (_pendingOrderCallbacks.has(orderId)) {
        const pending = _pendingOrderCallbacks.get(orderId)!;
        clearTimeout(pending.timer);
        _pendingOrderCallbacks.delete(orderId);
        pending.resolve({ orderId, avgFillPrice, filledQty: filled });
      }

      insertIbFill({
        order_id: orderId,
        ticker: '',  // orderStatus doesn't include contract info; execDetails will fill this
        side: '',
        quantity: filled,
        fill_price: avgFillPrice,
        filled_at: new Date().toISOString(),
      }).catch(err => console.warn(`[IB] Failed to persist orderStatus fill: ${err instanceof Error ? err.message : err}`));
    }

    // Reject on terminal non-fill statuses
    if ((status === 'Cancelled' || status === 'Inactive') && _pendingOrderCallbacks.has(orderId)) {
      const pending = _pendingOrderCallbacks.get(orderId)!;
      clearTimeout(pending.timer);
      _pendingOrderCallbacks.delete(orderId);
      console.error(`[IB] Order ${orderId} (${pending.symbol}) ${status}`);
      pending.reject(new Error(`IB order ${orderId} (${pending.symbol}) ${status}`));
    }
  });

  // execDetails gives us the definitive per-fill record with contract info
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ib as any).on(EventName.execDetails, (_reqId: number, contract: any, execution: any) => {
    const orderId = execution?.orderId ?? execution?.order?.orderId;
    const price = execution?.price ?? execution?.avgPrice;
    const qty = execution?.shares ?? execution?.cumQty ?? 0;
    const execId = execution?.execId ?? null;
    const side = execution?.side ?? '';
    const ticker = contract?.symbol ?? '';

    if (orderId && price > 0) {
      _orderFillPrices.set(orderId, price);
      console.log(`[IB] ExecDetails: order ${orderId} ${side} ${qty}x ${ticker} @ $${price.toFixed(4)} (execId=${execId})`);
      insertIbFill({
        order_id: orderId,
        exec_id: execId,
        ticker,
        side,
        quantity: qty,
        fill_price: price,
        filled_at: new Date().toISOString(),
      }).catch(err => console.warn(`[IB] Failed to persist execDetails fill: ${err instanceof Error ? err.message : err}`));
    }
  });

  // commissionReport arrives after execDetails — update the matching fill row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ib as any).on(EventName.commissionReport, (report: any) => {
    const execId = report?.execId;
    const commission = report?.commission;
    if (execId && commission != null && commission < 1e6) {
      console.log(`[IB] Commission: execId=${execId} commission=$${commission.toFixed(4)}`);
      updateIbFillCommission(execId, commission)
        .catch(err => console.warn(`[IB] Failed to update commission: ${err instanceof Error ? err.message : err}`));
    }
  });

  // Hydrate fill price cache from DB on connect so we survive restarts
  hydrateOrderFillPrices().catch(() => {});

  // Connect
  console.log(`[IB] Connecting to ${IB_HOST}:${IB_PORT} (clientId=${IB_CLIENT_ID})...`);
  ib.connect();
}

// ── Reconnect ────────────────────────────────────────────

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_MS
  );
  reconnectAttempts++;

  console.log(`[IB] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ── Contract Helper ──────────────────────────────────────

export function createStockContract(symbol: string): Contract {
  return {
    symbol: symbol.toUpperCase(),
    secType: SecType.STK,
    exchange: 'SMART',
    currency: 'USD',
  };
}

// ── Contract Search ──────────────────────────────────────

export interface ContractSearchResult {
  conId: number;
  symbol: string;
  secType: string;
  primaryExch: string;
  currency: string;
  description: string;
}

export async function searchContract(symbol: string): Promise<ContractSearchResult | null> {
  if (!ib || !connected) {
    throw new Error('Not connected to IB Gateway');
  }

  await acquireRequestSlot();
  try {
    return await new Promise<ContractSearchResult | null>((resolve) => {
      const reqId = getNextOrderId();
      // Use empty exchange for contract detail lookups — SMART is a routing strategy
      // and reqContractDetails can return empty results when exchange is set to SMART.
      const contract: Contract = {
        symbol: symbol.toUpperCase(),
        secType: SecType.STK,
        currency: 'USD',
      };
      let resolved = false;

      const cleanup = () => {
        unregisterReqErrorCallback(reqId);
      };

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      }, 10_000);

      // Register per-request error handler (e.g. code 200 = no security definition)
      registerReqErrorCallback(reqId, (_code: number, _msg: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emitter = ib as any;

      emitter.on(EventName.contractDetails, (rId: number, details: { contract: { conId?: number; symbol?: string; secType?: string; primaryExch?: string; currency?: string }; longName?: string }) => {
        if (rId !== reqId || resolved) return;
        resolved = true;
        clearTimeout(timeout);
        cleanup();

        resolve({
          conId: details.contract.conId ?? 0,
          symbol: details.contract.symbol ?? symbol,
          secType: details.contract.secType ?? 'STK',
          primaryExch: details.contract.primaryExch ?? '',
          currency: details.contract.currency ?? 'USD',
          description: details.longName ?? '',
        });
      });

      emitter.on(EventName.contractDetailsEnd, (rId: number) => {
        if (rId !== reqId || resolved) return;
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        resolve(null);
      });

      ib!.reqContractDetails(reqId, contract);
    });
  } finally {
    releaseRequestSlot();
  }
}

// ── Place Bracket Order ──────────────────────────────────

export interface BracketOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  tif?: 'DAY' | 'GTC';
}

export interface BracketOrderResult {
  parentOrderId: number;
  takeProfitOrderId: number;
  stopLossOrderId: number;
}

export function placeBracketOrder(params: BracketOrderParams): Promise<BracketOrderResult> {
  return new Promise((resolve, reject) => {
    if (!ib || !connected) {
      return reject(new Error('Not connected to IB Gateway'));
    }

    const { symbol, side, quantity, entryPrice, stopLoss, takeProfit, tif = 'GTC' } = params;

    // Hard gate: DAY orders must not be placed before 9:30 AM ET.
    // This is the lowest-level defense — even if application logic fails to check market hours,
    // the IB client will refuse to send the order. DAY orders expire at market close anyway,
    // so placing them pre-market means they'd be sent to IB before liquidity exists.
    if (tif === 'DAY') {
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etDay = etNow.getDay();
      const etMins = etNow.getHours() * 60 + etNow.getMinutes();
      const marketOpen = 9 * 60 + 30; // 9:30 AM ET
      if (etDay !== 0 && etDay !== 6 && etMins < marketOpen) {
        const etStr = `${String(etNow.getHours()).padStart(2, '0')}:${String(etNow.getMinutes()).padStart(2, '0')} ET`;
        console.error(`[IB] ❌ DAY bracket order for ${symbol} rejected — market not open yet (${etStr})`);
        return reject(new Error(`DAY order rejected: market not open (${etStr}) — order would be invalid before 9:30 AM ET`));
      }
    }
    const contract = createStockContract(symbol);

    const parentId = getNextOrderId();
    const tpId = getNextOrderId();
    const slId = getNextOrderId();

    const closeSide = side === 'BUY' ? OrderAction.SELL : OrderAction.BUY;
    const ibTif = tif === 'DAY' ? TimeInForce.DAY : TimeInForce.GTC;

    // Parent: limit entry
    const parentOrder: Order = {
      action: side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.LMT,
      totalQuantity: quantity,
      lmtPrice: entryPrice,
      tif: ibTif,
      transmit: false, // don't transmit yet — children first
    };

    // Take profit: limit close
    const takeProfitOrder: Order = {
      action: closeSide,
      orderType: OrderType.LMT,
      totalQuantity: quantity,
      lmtPrice: takeProfit,
      parentId,
      tif: ibTif,
      transmit: false,
    };

    // Stop loss: stop close
    const stopLossOrder: Order = {
      action: closeSide,
      orderType: OrderType.STP,
      totalQuantity: quantity,
      auxPrice: stopLoss,
      parentId,
      tif: ibTif,
      transmit: true, // transmit the whole bracket
    };

    // Place all three
    try {
      ib.placeOrder(parentId, contract, parentOrder);
      ib.placeOrder(tpId, contract, takeProfitOrder);
      ib.placeOrder(slId, contract, stopLossOrder);

      resolve({
        parentOrderId: parentId,
        takeProfitOrderId: tpId,
        stopLossOrderId: slId,
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ── Place Market Order (no bracket — simple buy/sell at market) ──

export interface MarketOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
}

export interface MarketOrderResult {
  orderId: number;
  avgFillPrice: number;
  filledQty: number;
}

const MKT_ORDER_TIMEOUT_MS = 30_000;

export function placeMarketOrder(params: MarketOrderParams): Promise<MarketOrderResult> {
  return new Promise((resolve, reject) => {
    if (!ib || !connected) {
      return reject(new Error('Not connected to IB Gateway'));
    }

    const { symbol, side, quantity } = params;
    const contract = createStockContract(symbol);
    const orderId = getNextOrderId();

    const order: Order = {
      action: side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: quantity,
      tif: TimeInForce.DAY,
      transmit: true,
    };

    const timer = setTimeout(() => {
      _pendingOrderCallbacks.delete(orderId);
      const msg = `IB order ${orderId} (${symbol} ${side} ${quantity}) timed out after ${MKT_ORDER_TIMEOUT_MS / 1000}s — no fill/error received`;
      console.error(`[IB] ${msg}`);
      reject(new Error(msg));
    }, MKT_ORDER_TIMEOUT_MS);

    _pendingOrderCallbacks.set(orderId, { resolve, reject, timer, symbol });

    try {
      ib.placeOrder(orderId, contract, order);
      console.log(`[IB] Market order dispatched: ${side} ${quantity}x ${symbol} (orderId=${orderId}) — awaiting fill...`);
    } catch (err) {
      clearTimeout(timer);
      _pendingOrderCallbacks.delete(orderId);
      reject(err);
    }
  });
}

// ── Cancel Order ─────────────────────────────────────────

export function cancelOrder(orderId: number): void {
  if (!ib || !connected) {
    throw new Error('Not connected to IB Gateway');
  }
  ib.cancelOrder(orderId);
}

// ── Positions ────────────────────────────────────────────

export interface PositionData {
  account: string;
  symbol: string;
  secType: string;
  position: number;
  avgCost: number;
  conId: number;
}

export function requestPositions(): Promise<PositionData[]> {
  return new Promise((resolve, reject) => {
    if (!ib || !connected) {
      return reject(new Error('Not connected to IB Gateway'));
    }

    const positions: PositionData[] = [];
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(positions);
      }
    }, 10_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitter = ib as any;

    const posHandler = (account: string, contract: Contract, pos: number, avgCost: number) => {
      if (resolved) return;
      positions.push({
        account,
        symbol: contract.symbol ?? '',
        secType: contract.secType ?? '',
        position: pos,
        avgCost,
        conId: contract.conId ?? 0,
      });
    };

    const endHandler = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      emitter.off(EventName.position, posHandler);
      emitter.off(EventName.positionEnd, endHandler);
      resolve(positions);
    };

    emitter.on(EventName.position, posHandler);
    emitter.on(EventName.positionEnd, endHandler);
    ib.reqPositions();
  });
}

// ── Open Orders ──────────────────────────────────────────

export interface OpenOrderData {
  orderId: number;
  symbol: string;
  action: string;
  orderType: string;
  totalQuantity: number;
  lmtPrice: number;
  auxPrice: number;
  status: string;
  parentId: number;
}

export function requestOpenOrders(): Promise<OpenOrderData[]> {
  return new Promise((resolve, reject) => {
    if (!ib || !connected) {
      return reject(new Error('Not connected to IB Gateway'));
    }

    const orders: OpenOrderData[] = [];
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(orders);
      }
    }, 10_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitter = ib as any;

    const orderHandler = (orderId: number, contract: Contract, order: Order, orderState: { status?: string }) => {
      if (resolved) return;
      orders.push({
        orderId,
        symbol: contract.symbol ?? '',
        action: String(order.action ?? ''),
        orderType: String(order.orderType ?? ''),
        totalQuantity: Number(order.totalQuantity ?? 0),
        lmtPrice: Number(order.lmtPrice ?? 0),
        auxPrice: Number(order.auxPrice ?? 0),
        status: orderState.status ?? '',
        parentId: Number(order.parentId ?? 0),
      });
    };

    const endHandler = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      emitter.off(EventName.openOrder, orderHandler);
      emitter.off(EventName.openOrderEnd, endHandler);
      resolve(orders);
    };

    emitter.on(EventName.openOrder, orderHandler);
    emitter.on(EventName.openOrderEnd, endHandler);
    ib.reqAllOpenOrders();
  });
}

// ── Place Options Order (sell put / sell call) ────────────

export interface OptionsOrderParams {
  symbol: string;
  right: 'P' | 'C';   // Put or Call
  strike: number;
  expiry: string;      // YYYYMMDD
  contracts: number;   // number of contracts (each = 100 shares)
  limitPrice: number;  // premium per share (e.g. 2.50)
  account?: string;
}

export interface OptionsOrderResult {
  orderId: number;
}

export function placeOptionsOrder(params: OptionsOrderParams): Promise<OptionsOrderResult> {
  return new Promise((resolve, reject) => {
    if (!ib || !connected) {
      return reject(new Error('Not connected to IB Gateway'));
    }

    const { symbol, right, strike, expiry, contracts, account } = params;
    // IB requires limit prices to conform to minimum tick increments.
    // Options ≥ $3.00 use $0.05 ticks; options < $3.00 use $0.01 ticks.
    const tick = params.limitPrice >= 3.0 ? 0.05 : 0.01;
    const limitPrice = Math.round(params.limitPrice / tick) * tick;

    const contract: Contract = {
      symbol: symbol.toUpperCase(),
      secType: SecType.OPT,
      exchange: 'SMART',
      currency: 'USD',
      strike,
      right: right === 'P' ? OptionType.Put : OptionType.Call,
      lastTradeDateOrContractMonth: expiry,
      multiplier: 100,
    };

    const orderId = getNextOrderId();

    const order: Order = {
      action: OrderAction.SELL,
      orderType: OrderType.LMT,
      totalQuantity: contracts,
      lmtPrice: limitPrice,
      tif: TimeInForce.DAY,
      transmit: true,
      ...(account ? { account } : {}),
    };

    try {
      ib.placeOrder(orderId, contract, order);
      console.log(`[IB] Options order placed: SELL ${contracts}x ${symbol} $${strike}${right} ${expiry} @ $${limitPrice} (orderId=${orderId})`);
      resolve({ orderId });
    } catch (err) {
      reject(err);
    }
  });
}

// ── Disconnect ───────────────────────────────────────────

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ib) {
    if (_pnlReqId) {
      try { ib.cancelPnL(_pnlReqId); } catch { /* ignore */ }
    }
    try { ib.disconnect(); } catch { /* ignore */ }
    ib = null;
  }
  _dailyPnL = null;
  _unrealizedPnL = null;
  _realizedPnL = null;
  connected = false;
}
