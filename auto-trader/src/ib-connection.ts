/**
 * IB Gateway connection manager using @stoqey/ib (TWS API).
 *
 * - Auto-connects to IB Gateway on port 4002 (paper trading)
 * - Auto-reconnects on disconnect with exponential backoff
 * - Exposes connection state + account info to REST routes
 */

import { IBApi, EventName, Contract, Order, OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';

// ── Configuration ────────────────────────────────────────

const IB_HOST = process.env.IB_HOST ?? '127.0.0.1';
const IB_PORT = parseInt(process.env.IB_PORT ?? '4002', 10);
const IB_CLIENT_ID = parseInt(process.env.IB_CLIENT_ID ?? '1', 10);

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// ── State ────────────────────────────────────────────────

let ib: IBApi | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let accounts: string[] = [];
let nextOrderId = 0;
let connectionListeners: Array<(state: boolean) => void> = [];

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

    console.error(`[IB] Error (code=${code}, reqId=${reqId}): ${err.message}`);

    if (code === 1100) {
      connected = false;
      connectionListeners.forEach(fn => fn(false));
    }
  });

  ib.on(EventName.managedAccounts, (accountsList: string) => {
    accounts = accountsList.split(',').map(a => a.trim()).filter(Boolean);
    console.log(`[IB] Managed accounts: ${accounts.join(', ')}`);
  });

  ib.on(EventName.nextValidId, (orderId: number) => {
    nextOrderId = orderId;
    console.log(`[IB] Next valid order ID: ${nextOrderId}`);
  });

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

export function searchContract(symbol: string): Promise<ContractSearchResult | null> {
  return new Promise((resolve, reject) => {
    if (!ib || !connected) {
      return reject(new Error('Not connected to IB Gateway'));
    }

    const reqId = getNextOrderId();
    const contract = createStockContract(symbol);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, 10_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitter = ib as any;

    // Use reqContractDetails to get full contract info including conId
    emitter.on(EventName.contractDetails, (rId: number, details: { contract: { conId?: number; symbol?: string; secType?: string; primaryExch?: string; currency?: string }; longName?: string }) => {
      if (rId !== reqId || resolved) return;
      resolved = true;
      clearTimeout(timeout);

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
      resolve(null);
    });

    ib.reqContractDetails(reqId, contract);
  });
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

// ── Disconnect ───────────────────────────────────────────

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ib) {
    try { ib.disconnect(); } catch { /* ignore */ }
    ib = null;
  }
  connected = false;
}
