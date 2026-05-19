/**
 * IB Gateway connection manager using @stoqey/ib (TWS API).
 *
 * Dual-account architecture:
 *   - paperConn: port 4002, clientId=1 (paper trading — existing)
 *   - liveConn:  port 4001, clientId=2 (live trading — new)
 *
 * All existing module-level exports (isConnected, placeMarketOrder, etc.)
 * are backward-compatible thin wrappers delegating to paperConn.
 * New dual-account code uses the IBConnection class API directly.
 */

import { IBApi, EventName, Contract, Order, OrderAction, OrderType, SecType, TimeInForce, OptionType } from '@stoqey/ib';
import { insertIbFill, updateIbFillCommission, getTodayFillPrices, getFillPriceByOrderId, saveConfigPartial, createAutoTradeEvent } from './lib/supabase.js';
import type { AccountType } from '../../shared/trade-types.js';

// ── Constants ────────────────────────────────────────────

const IB_HOST = process.env.IB_HOST ?? '127.0.0.1';
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_CONCURRENT_REQUESTS = 8;
const MKT_ORDER_TIMEOUT_MS = 30_000;
const OPT_ORDER_TIMEOUT_MS = 120_000;

// ── Interfaces (unchanged from original, re-exported) ────

export interface AccountPnL {
  dailyPnL: number | null;
  unrealizedPnL: number | null;
  realizedPnL: number | null;
}

export interface ContractSearchResult {
  conId: number;
  symbol: string;
  secType: string;
  primaryExch: string;
  currency: string;
  description: string;
}

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

export interface PositionData {
  account: string;
  symbol: string;
  secType: string;
  position: number;
  avgCost: number;
  conId: number;
}

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

export interface OptionsOrderParams {
  symbol: string;
  right: 'P' | 'C';
  strike: number;
  expiry: string;
  contracts: number;
  limitPrice: number;
  account?: string;
  action?: 'BUY' | 'SELL';
  tradingClass?: string;
}

export interface OptionsOrderResult {
  orderId: number;
  avgFillPrice: number;
  filledQty: number;
}

export interface CalendarSpreadOrderParams {
  symbol: string;
  right: 'P' | 'C';
  strike: number;
  frontExpiry: string;
  backExpiry: string;
  contracts: number;
  limitPrice: number;
  account?: string;
}

export interface CalendarSpreadOrderResult {
  orderId: number;
}

export interface VerticalSpreadOrderParams {
  symbol: string;
  right: 'P' | 'C';
  sellStrike: number;
  buyStrike: number;
  expiry: string;
  contracts: number;
  limitPrice: number;
  account?: string;
  action?: 'BUY' | 'SELL';
}

export interface VerticalSpreadOrderResult {
  orderId: number;
}

interface PendingOrder {
  resolve: (result: { orderId: number; avgFillPrice: number; filledQty: number }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  symbol: string;
}

// ── IBConnection Class ───────────────────────────────────

export class IBConnection {
  readonly label: AccountType;
  readonly port: number;
  readonly clientId: number;

  private ib: IBApi | null = null;
  private _connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _accounts: string[] = [];
  private _nextOrderId = 0;
  private connectionListeners: Array<(state: boolean) => void> = [];

  private _pnlReqId = 0;
  private _pnlSubscribed = false;
  private _dailyPnL: number | null = null;
  private _unrealizedPnL: number | null = null;
  private _realizedPnL: number | null = null;

  private _orderFillPrices = new Map<number, number>();
  private _pendingReqCallbacks = new Map<number, (code: number, msg: string) => void>();
  private _pendingOrderCallbacks = new Map<number, PendingOrder>();

  private _activeRequests = 0;
  private _requestQueue: Array<() => void> = [];

  private _consecutiveCode200 = 0;
  private static readonly CODE_200_RECONNECT_THRESHOLD = 3;

  private get tag(): string { return `[IB:${this.label}]`; }

  constructor(label: AccountType, port: number, clientId: number) {
    this.label = label;
    this.port = port;
    this.clientId = clientId;
  }

  // ── Semaphore ────────────────────────────────────────

  async acquireRequestSlot(): Promise<void> {
    if (this._activeRequests < MAX_CONCURRENT_REQUESTS) {
      this._activeRequests++;
      return;
    }
    return new Promise<void>(resolve => {
      this._requestQueue.push(() => { this._activeRequests++; resolve(); });
    });
  }

  releaseRequestSlot(): void {
    this._activeRequests--;
    const next = this._requestQueue.shift();
    if (next) next();
  }

  registerReqErrorCallback(reqId: number, cb: (code: number, msg: string) => void): void {
    this._pendingReqCallbacks.set(reqId, cb);
  }

  unregisterReqErrorCallback(reqId: number): void {
    this._pendingReqCallbacks.delete(reqId);
  }

  // ── Public API ───────────────────────────────────────

  isConnected(): boolean { return this._connected; }
  getAccounts(): string[] { return this._accounts; }
  getDefaultAccount(): string | null { return this._accounts[0] ?? null; }
  getIBApi(): IBApi | null { return this.ib; }

  getNextOrderId(): number { return this._nextOrderId++; }

  onConnectionChange(fn: (state: boolean) => void): () => void {
    this.connectionListeners.push(fn);
    return () => {
      this.connectionListeners = this.connectionListeners.filter(l => l !== fn);
    };
  }

  getDailyPnL(): AccountPnL {
    return { dailyPnL: this._dailyPnL, unrealizedPnL: this._unrealizedPnL, realizedPnL: this._realizedPnL };
  }

  getOrderFillPrice(orderId: number): number | undefined {
    return this._orderFillPrices.get(orderId);
  }

  async getOrderFillPriceWithFallback(orderId: number): Promise<number | undefined> {
    const cached = this._orderFillPrices.get(orderId);
    if (cached !== undefined) return cached;
    const dbPrice = await getFillPriceByOrderId(orderId, this.label);
    if (dbPrice !== undefined) {
      this._orderFillPrices.set(orderId, dbPrice);
    }
    return dbPrice;
  }

  private _subscribeToPnlIfReady(): void {
    if (this._pnlSubscribed) return;
    if (this._accounts.length === 0 || this._nextOrderId === 0 || !this.ib) return;

    // Cancel any stale subscription from a prior connect cycle
    if (this._pnlReqId) {
      try { this.ib.cancelPnL(this._pnlReqId); } catch { /* ignore */ }
    }

    this._pnlReqId = this.getNextOrderId();
    this._dailyPnL = null;
    this._unrealizedPnL = null;
    this._realizedPnL = null;
    try {
      this.ib.reqPnL(this._pnlReqId, this._accounts[0], '');
      this._pnlSubscribed = true;
      console.log(`${this.tag} Subscribed to account PnL (reqId=${this._pnlReqId}, account=${this._accounts[0]})`);
    } catch (pnlErr) {
      console.warn(`${this.tag} reqPnL failed:`, pnlErr instanceof Error ? pnlErr.message : pnlErr);
    }
  }

  // ── Connect ──────────────────────────────────────────

  connect(): void {
    if (this.ib) {
      try { this.ib.disconnect(); } catch { /* ignore */ }
    }

    this.ib = new IBApi({ host: IB_HOST, port: this.port, clientId: this.clientId });
    const ib = this.ib;

    ib.on(EventName.connected, () => {
      console.log(`${this.tag} Connected to IB Gateway at ${IB_HOST}:${this.port}`);
      this._connected = true;
      this.reconnectAttempts = 0;
      this.connectionListeners.forEach(fn => fn(true));
      ib.reqManagedAccts();
      ib.reqIds();
    });

    ib.on(EventName.disconnected, () => {
      console.log(`${this.tag} Disconnected from IB Gateway`);
      this._connected = false;
      this.connectionListeners.forEach(fn => fn(false));

      if (this.label === 'live') {
        console.log(`${this.tag} Live connection lost — auto-engaging kill switch`);
        saveConfigPartial({ liveKillSwitch: true }).catch(err => {
          console.error(`${this.tag} Failed to auto-engage kill switch: ${err}`);
        });
        createAutoTradeEvent({
          ticker: 'SYSTEM',
          event_type: 'error',
          action: 'failed',
          source: 'system',
          message: `[IB:live] Connection lost — kill switch auto-engaged`,
        }, 'live').catch(() => {});
      }

      this.scheduleReconnect();
    });

    ib.on(EventName.error, (err: Error, code?: number, reqId?: number) => {
      const infoOnly = code && [2104, 2106, 2108, 2158].includes(code);
      if (infoOnly) {
        console.log(`${this.tag} Info (${code}): ${err.message}`);
        return;
      }

      if (reqId != null && code != null && this._pendingReqCallbacks.has(reqId)) {
        const cb = this._pendingReqCallbacks.get(reqId)!;
        this._pendingReqCallbacks.delete(reqId);
        cb(code, err.message);
        return;
      }

      if (reqId != null && this._pendingOrderCallbacks.has(reqId)) {
        const pending = this._pendingOrderCallbacks.get(reqId)!;
        clearTimeout(pending.timer);
        this._pendingOrderCallbacks.delete(reqId);
        const msg = `IB order ${reqId} (${pending.symbol}) rejected: code=${code} ${err.message}`;
        console.error(`${this.tag} ${msg}`);
        pending.reject(new Error(msg));

        if (code === 200) {
          this._consecutiveCode200++;
          if (this._consecutiveCode200 >= IBConnection.CODE_200_RECONNECT_THRESHOLD) {
            console.error(`${this.tag} ⚠️ ${this._consecutiveCode200} consecutive code-200 rejections — gateway session likely degraded, forcing reconnect`);
            this._consecutiveCode200 = 0;
            this._connected = false;
            this.connectionListeners.forEach(fn => fn(false));
            try { this.ib?.disconnect(); } catch { /* ignore */ }
            this.scheduleReconnect();
          }
        } else {
          this._consecutiveCode200 = 0;
        }
        return;
      }

      console.error(`${this.tag} Error (code=${code}, reqId=${reqId}): ${err.message}`);

      if (code === 1100) {
        this._connected = false;
        this.connectionListeners.forEach(fn => fn(false));
      }
    });

    ib.on(EventName.managedAccounts, (accountsList: string) => {
      this._accounts = accountsList.split(',').map(a => a.trim()).filter(Boolean);
      console.log(`${this.tag} Managed accounts: ${this._accounts.join(', ')}`);
      this._subscribeToPnlIfReady();
    });

    ib.on(EventName.nextValidId, (orderId: number) => {
      this._nextOrderId = orderId;
      console.log(`${this.tag} Next valid order ID: ${this._nextOrderId}`);
      this._subscribeToPnlIfReady();
    });

    ib.on(EventName.pnl, (reqId: number, dailyPnL: number, unrealizedPnL?: number, realizedPnL?: number) => {
      if (reqId !== this._pnlReqId) return;
      this._dailyPnL = dailyPnL;
      this._unrealizedPnL = unrealizedPnL ?? null;
      this._realizedPnL = realizedPnL ?? null;
    });

    ib.on(EventName.orderStatus, (
      orderId: number, status: string, filled: number,
      _remaining: number, avgFillPrice: number,
    ) => {
      if (status === 'Filled' && avgFillPrice > 0) {
        this._orderFillPrices.set(orderId, avgFillPrice);
        this._consecutiveCode200 = 0;
        console.log(`${this.tag} Order ${orderId} filled @ $${avgFillPrice.toFixed(4)}`);

        if (this._pendingOrderCallbacks.has(orderId)) {
          const pending = this._pendingOrderCallbacks.get(orderId)!;
          clearTimeout(pending.timer);
          this._pendingOrderCallbacks.delete(orderId);
          pending.resolve({ orderId, avgFillPrice, filledQty: filled });
        }

        insertIbFill({
          order_id: orderId,
          ticker: '',
          side: '',
          quantity: filled,
          fill_price: avgFillPrice,
          filled_at: new Date().toISOString(),
        }, this.label).catch(fillErr => console.warn(`${this.tag} Failed to persist orderStatus fill: ${fillErr instanceof Error ? fillErr.message : fillErr}`));
      }

      if ((status === 'Cancelled' || status === 'Inactive') && this._pendingOrderCallbacks.has(orderId)) {
        const pending = this._pendingOrderCallbacks.get(orderId)!;
        clearTimeout(pending.timer);
        this._pendingOrderCallbacks.delete(orderId);
        console.error(`${this.tag} Order ${orderId} (${pending.symbol}) ${status}`);
        pending.reject(new Error(`IB order ${orderId} (${pending.symbol}) ${status}`));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ib as any).on(EventName.execDetails, (_reqId: number, contract: any, execution: any) => {
      const orderId = execution?.orderId ?? execution?.order?.orderId;
      const price = execution?.price ?? execution?.avgPrice;
      const qty = execution?.shares ?? execution?.cumQty ?? 0;
      const execId = execution?.execId ?? null;
      const side = execution?.side ?? '';
      const ticker = contract?.symbol ?? '';

      if (orderId && price > 0) {
        this._orderFillPrices.set(orderId, price);
        console.log(`${this.tag} ExecDetails: order ${orderId} ${side} ${qty}x ${ticker} @ $${price.toFixed(4)} (execId=${execId})`);
        insertIbFill({
          order_id: orderId,
          exec_id: execId,
          ticker,
          side,
          quantity: qty,
          fill_price: price,
          filled_at: new Date().toISOString(),
        }, this.label).catch(fillErr => console.warn(`${this.tag} Failed to persist execDetails fill: ${fillErr instanceof Error ? fillErr.message : fillErr}`));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ib as any).on(EventName.commissionReport, (report: any) => {
      const execId = report?.execId;
      const commission = report?.commission;
      const realizedPnl: number | undefined = report?.realizedPNL ?? report?.realizedPnl;
      if (execId && commission != null && commission < 1e6) {
        const rpnlStr = realizedPnl != null && isFinite(realizedPnl) && Math.abs(realizedPnl) < 1e6
          ? ` realizedPnl=$${realizedPnl.toFixed(2)}` : '';
        console.log(`${this.tag} Commission: execId=${execId} commission=$${commission.toFixed(4)}${rpnlStr}`);
        updateIbFillCommission(execId, commission, realizedPnl != null && isFinite(realizedPnl) && Math.abs(realizedPnl) < 1e6 ? realizedPnl : null, this.label)
          .catch(commErr => console.warn(`${this.tag} Failed to update commission: ${commErr instanceof Error ? commErr.message : commErr}`));
      }
    });

    this.hydrateOrderFillPrices().catch(() => {});

    console.log(`${this.tag} Connecting to ${IB_HOST}:${this.port} (clientId=${this.clientId})...`);
    ib.connect();
  }

  // ── Reconnect ────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts++;

    console.log(`${this.tag} Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ── Fill Price Hydration ─────────────────────────────

  private async hydrateOrderFillPrices(): Promise<void> {
    try {
      const fills = await getTodayFillPrices(this.label);
      let count = 0;
      for (const [orderId, price] of fills) {
        if (!this._orderFillPrices.has(orderId)) {
          this._orderFillPrices.set(orderId, price);
          count++;
        }
      }
      if (count > 0) {
        console.log(`${this.tag} Hydrated ${count} fill prices from DB`);
      }
    } catch (err) {
      console.warn(`${this.tag} Failed to hydrate fill prices from DB:`, err instanceof Error ? err.message : err);
    }
  }

  // ── Contract Helper ──────────────────────────────────

  createStockContract(symbol: string): Contract {
    return {
      symbol: symbol.toUpperCase(),
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    };
  }

  // ── Contract Search ──────────────────────────────────

  async searchContract(symbol: string): Promise<ContractSearchResult | null> {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }

    await this.acquireRequestSlot();
    try {
      return await new Promise<ContractSearchResult | null>((resolve) => {
        const reqId = this.getNextOrderId();
        const contract: Contract = {
          symbol: symbol.toUpperCase(),
          secType: SecType.STK,
          currency: 'USD',
        };
        let resolved = false;

        const cleanup = () => { this.unregisterReqErrorCallback(reqId); };

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(null);
          }
        }, 10_000);

        this.registerReqErrorCallback(reqId, (_code: number, _msg: string) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const emitter = this.ib as any;

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

        this.ib!.reqContractDetails(reqId, contract);
      });
    } finally {
      this.releaseRequestSlot();
    }
  }

  // ── Place Bracket Order ──────────────────────────────

  placeBracketOrder(params: BracketOrderParams): Promise<BracketOrderResult> {
    return new Promise((resolve, reject) => {
      if (!this.ib || !this._connected) {
        return reject(new Error(`${this.tag} Not connected to IB Gateway`));
      }

      const { symbol, side, quantity, entryPrice, stopLoss, takeProfit, tif = 'GTC' } = params;

      if (tif === 'DAY') {
        const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const etDay = etNow.getDay();
        const etMins = etNow.getHours() * 60 + etNow.getMinutes();
        const marketOpen = 9 * 60 + 30;
        if (etDay !== 0 && etDay !== 6 && etMins < marketOpen) {
          const etStr = `${String(etNow.getHours()).padStart(2, '0')}:${String(etNow.getMinutes()).padStart(2, '0')} ET`;
          console.error(`${this.tag} DAY bracket order for ${symbol} rejected — market not open yet (${etStr})`);
          return reject(new Error(`DAY order rejected: market not open (${etStr}) — order would be invalid before 9:30 AM ET`));
        }
      }

      const contract = this.createStockContract(symbol);
      const parentId = this.getNextOrderId();
      const tpId = this.getNextOrderId();
      const slId = this.getNextOrderId();
      const closeSide = side === 'BUY' ? OrderAction.SELL : OrderAction.BUY;
      const ibTif = tif === 'DAY' ? TimeInForce.DAY : TimeInForce.GTC;

      const parentOrder: Order = {
        action: side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
        orderType: OrderType.LMT,
        totalQuantity: quantity,
        lmtPrice: entryPrice,
        tif: ibTif,
        transmit: false,
      };

      const takeProfitOrder: Order = {
        action: closeSide,
        orderType: OrderType.LMT,
        totalQuantity: quantity,
        lmtPrice: takeProfit,
        parentId,
        tif: ibTif,
        transmit: false,
      };

      const stopLossOrder: Order = {
        action: closeSide,
        orderType: OrderType.STP,
        totalQuantity: quantity,
        auxPrice: stopLoss,
        parentId,
        tif: ibTif,
        transmit: true,
      };

      try {
        this.ib.placeOrder(parentId, contract, parentOrder);
        this.ib.placeOrder(tpId, contract, takeProfitOrder);
        this.ib.placeOrder(slId, contract, stopLossOrder);
        console.log(`${this.tag} Bracket order placed: ${side} ${quantity}x ${symbol} entry=$${entryPrice} tp=$${takeProfit} sl=$${stopLoss}`);
        resolve({ parentOrderId: parentId, takeProfitOrderId: tpId, stopLossOrderId: slId });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── Place Market Order ───────────────────────────────

  placeMarketOrder(params: MarketOrderParams): Promise<MarketOrderResult> {
    return new Promise((resolve, reject) => {
      if (!this.ib || !this._connected) {
        return reject(new Error(`${this.tag} Not connected to IB Gateway`));
      }

      const { symbol, side, quantity } = params;
      const contract = this.createStockContract(symbol);
      const orderId = this.getNextOrderId();

      const order: Order = {
        action: side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
        orderType: OrderType.MKT,
        totalQuantity: quantity,
        tif: TimeInForce.DAY,
        transmit: true,
      };

      const timer = setTimeout(() => {
        this._pendingOrderCallbacks.delete(orderId);
        const msg = `IB order ${orderId} (${symbol} ${side} ${quantity}) timed out after ${MKT_ORDER_TIMEOUT_MS / 1000}s — no fill/error received`;
        console.error(`${this.tag} ${msg}`);
        reject(new Error(msg));
      }, MKT_ORDER_TIMEOUT_MS);

      this._pendingOrderCallbacks.set(orderId, { resolve, reject, timer, symbol });

      try {
        this.ib.placeOrder(orderId, contract, order);
        console.log(`${this.tag} Market order dispatched: ${side} ${quantity}x ${symbol} (orderId=${orderId}) — awaiting fill...`);
      } catch (err) {
        clearTimeout(timer);
        this._pendingOrderCallbacks.delete(orderId);
        reject(err);
      }
    });
  }

  // ── Cancel Order ─────────────────────────────────────

  cancelOrder(orderId: number): void {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }
    this.ib.cancelOrder(orderId);
  }

  // ── Positions ────────────────────────────────────────

  requestPositions(): Promise<PositionData[]> {
    return new Promise((resolve, reject) => {
      if (!this.ib || !this._connected) {
        return reject(new Error(`${this.tag} Not connected to IB Gateway`));
      }

      const positions: PositionData[] = [];
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(positions); }
      }, 10_000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emitter = this.ib as any;

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
      this.ib.reqPositions();
    });
  }

  // ── Open Orders ──────────────────────────────────────

  requestOpenOrders(): Promise<OpenOrderData[]> {
    return new Promise((resolve, reject) => {
      if (!this.ib || !this._connected) {
        return reject(new Error(`${this.tag} Not connected to IB Gateway`));
      }

      const orders: OpenOrderData[] = [];
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(orders); }
      }, 10_000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emitter = this.ib as any;

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
      this.ib.reqAllOpenOrders();
    });
  }

  // ── Options Order ────────────────────────────────────

  placeOptionsOrder(params: OptionsOrderParams): Promise<OptionsOrderResult> {
    return new Promise((resolve, reject) => {
      if (!this.ib || !this._connected) {
        return reject(new Error(`${this.tag} Not connected to IB Gateway`));
      }

      const { symbol, right, strike, expiry, contracts, account } = params;
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
        tradingClass: params.tradingClass ?? symbol.toUpperCase(),
      };

      const orderId = this.getNextOrderId();

      const orderAction = params.action === 'BUY' ? OrderAction.BUY : OrderAction.SELL;

      const order: Order = {
        action: orderAction,
        orderType: OrderType.LMT,
        totalQuantity: contracts,
        lmtPrice: limitPrice,
        tif: TimeInForce.DAY,
        transmit: true,
        ...(account ? { account } : {}),
      };

      const timer = setTimeout(() => {
        this._pendingOrderCallbacks.delete(orderId);
        const msg = `IB options order ${orderId} (${symbol} $${strike}${right}) timed out after ${OPT_ORDER_TIMEOUT_MS / 1000}s — no fill/reject received`;
        console.error(`${this.tag} ${msg}`);
        reject(new Error(msg));
      }, OPT_ORDER_TIMEOUT_MS);

      this._pendingOrderCallbacks.set(orderId, { resolve, reject, timer, symbol });

      const actionLabel = params.action === 'BUY' ? 'BUY' : 'SELL';
      try {
        this.ib.placeOrder(orderId, contract, order);
        console.log(`${this.tag} Options order dispatched: ${actionLabel} ${contracts}x ${symbol} $${strike}${right} ${expiry} @ $${limitPrice} (orderId=${orderId}) — awaiting fill...`);
      } catch (err) {
        clearTimeout(timer);
        this._pendingOrderCallbacks.delete(orderId);
        reject(err);
      }
    });
  }

  // ── Resolve Option ConId ─────────────────────────────

  async resolveOptionConId(
    symbol: string, right: 'P' | 'C', strike: number, expiry: string,
  ): Promise<number | null> {
    if (!this.ib || !this._connected) return null;
    await this.acquireRequestSlot();
    try {
      return await new Promise<number | null>((resolve) => {
        const reqId = this.getNextOrderId();
        const emitter = this.ib! as unknown as NodeJS.EventEmitter;
        let resolved = false;
        const timeout = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          emitter.removeAllListeners(`contractDetails-${reqId}`);
          resolve(null);
        }, 8_000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitter.once(EventName.contractDetails, (_rId: number, details: any) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          resolve(details?.contract?.conId ?? null);
        });

        this.registerReqErrorCallback(reqId, () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        });

        this.ib!.reqContractDetails(reqId, {
          symbol: symbol.toUpperCase(),
          secType: SecType.OPT,
          exchange: 'SMART',
          currency: 'USD',
          strike,
          right: right === 'P' ? OptionType.Put : OptionType.Call,
          lastTradeDateOrContractMonth: expiry,
          multiplier: 100,
          tradingClass: symbol.toUpperCase(),
        });
      });
    } finally {
      this.releaseRequestSlot();
    }
  }

  // ── Calendar Spread ──────────────────────────────────

  async placeCalendarSpreadOrder(
    params: CalendarSpreadOrderParams,
  ): Promise<CalendarSpreadOrderResult> {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }

    const { symbol, right, strike, frontExpiry, backExpiry, contracts, account } = params;

    const [frontConId, backConId] = await Promise.all([
      this.resolveOptionConId(symbol, right, strike, frontExpiry),
      this.resolveOptionConId(symbol, right, strike, backExpiry),
    ]);
    if (!frontConId || !backConId) {
      throw new Error(`Could not resolve conIds for ${symbol} ${strike}${right} ${frontExpiry}/${backExpiry}`);
    }

    const tick = params.limitPrice >= 3.0 ? 0.05 : 0.01;
    const limitPrice = Math.round(params.limitPrice / tick) * tick;

    const contract: Contract = {
      symbol: symbol.toUpperCase(),
      secType: SecType.BAG,
      exchange: 'SMART',
      currency: 'USD',
      comboLegs: [
        { conId: frontConId, ratio: 1, action: OrderAction.SELL, exchange: 'SMART' },
        { conId: backConId,  ratio: 1, action: OrderAction.BUY,  exchange: 'SMART' },
      ],
    };

    const orderId = this.getNextOrderId();

    const order: Order = {
      action: OrderAction.BUY,
      orderType: OrderType.LMT,
      totalQuantity: contracts,
      lmtPrice: limitPrice,
      tif: TimeInForce.DAY,
      transmit: true,
      ...(account ? { account } : {}),
    };

    try {
      this.ib.placeOrder(orderId, contract, order);
      console.log(`${this.tag} Calendar spread placed: ${symbol} ${strike}${right} sell ${frontExpiry} / buy ${backExpiry} x${contracts} @ $${limitPrice} net debit (orderId=${orderId})`);
      return { orderId };
    } catch (err) {
      throw err;
    }
  }

  // ── Vertical Spread ──────────────────────────────────

  async placeVerticalSpreadOrder(
    params: VerticalSpreadOrderParams,
  ): Promise<VerticalSpreadOrderResult> {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }

    const { symbol, right, sellStrike, buyStrike, expiry, contracts, account } = params;

    const [sellConId, buyConId] = await Promise.all([
      this.resolveOptionConId(symbol, right, sellStrike, expiry),
      this.resolveOptionConId(symbol, right, buyStrike, expiry),
    ]);
    if (!sellConId || !buyConId) {
      throw new Error(`Could not resolve conIds for ${symbol} ${sellStrike}/${buyStrike}${right} ${expiry}`);
    }

    const tick = params.limitPrice >= 3.0 ? 0.05 : 0.01;
    const limitPrice = Math.round(params.limitPrice / tick) * tick;

    const contract: Contract = {
      symbol: symbol.toUpperCase(),
      secType: SecType.BAG,
      exchange: 'SMART',
      currency: 'USD',
      comboLegs: [
        { conId: sellConId, ratio: 1, action: OrderAction.SELL, exchange: 'SMART' },
        { conId: buyConId,  ratio: 1, action: OrderAction.BUY,  exchange: 'SMART' },
      ],
    };

    const orderId = this.getNextOrderId();

    const spreadAction = params.action === 'BUY' ? OrderAction.BUY : OrderAction.SELL;
    const spreadActionLabel = params.action === 'BUY' ? 'BUY' : 'SELL';
    const creditDebitLabel = params.action === 'BUY' ? 'net debit' : 'net credit';

    const order: Order = {
      action: spreadAction,
      orderType: OrderType.LMT,
      totalQuantity: contracts,
      lmtPrice: limitPrice,
      tif: TimeInForce.DAY,
      transmit: true,
      ...(account ? { account } : {}),
    };

    try {
      this.ib.placeOrder(orderId, contract, order);
      console.log(`${this.tag} Credit spread placed: ${spreadActionLabel} ${contracts}x ${symbol} ${sellStrike}/${buyStrike}${right} ${expiry} @ $${limitPrice} ${creditDebitLabel} (orderId=${orderId})`);
      return { orderId };
    } catch (err) {
      throw err;
    }
  }

  // ── Disconnect ───────────────────────────────────────

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ib) {
      if (this._pnlReqId) {
        try { this.ib.cancelPnL(this._pnlReqId); } catch { /* ignore */ }
      }
      try { this.ib.disconnect(); } catch { /* ignore */ }
      this.ib = null;
    }
    this._dailyPnL = null;
    this._unrealizedPnL = null;
    this._realizedPnL = null;
    this._pnlSubscribed = false;
    this._connected = false;
  }
}

// ══════════════════════════════════════════════════════════
// ── Connection Registry (Module-Level) ───────────────────
// ══════════════════════════════════════════════════════════

let paperConn: IBConnection | null = null;
let liveConn: IBConnection | null = null;

export function initConnections(opts?: { liveKillSwitch?: boolean }): void {
  paperConn = new IBConnection('paper', 4002, 1);
  liveConn = new IBConnection('live', 4001, 2);

  paperConn.connect();

  if (!opts?.liveKillSwitch) {
    liveConn.connect();
  } else {
    console.log('[IB:live] Not connecting — kill switch is active');
  }
}

export function getPaperConnection(): IBConnection {
  if (!paperConn) throw new Error('Paper connection not initialized — call initConnections() first');
  return paperConn;
}

/**
 * Minimal stub returned when liveConn hasn't been initialized (e.g. index.ts
 * uses the legacy connect() path instead of initConnections()). Every call
 * site checks isConnected() and skips when false, so this prevents crashes
 * without changing behavior.
 */
const disconnectedStub = Object.freeze({
  label: 'live' as AccountType,
  port: 4001,
  clientId: 2,
  isConnected: () => false,
  getAccounts: () => [] as string[],
  getDefaultAccount: () => null,
  getIBApi: () => null,
  getNextOrderId: () => 0,
  getDailyPnL: (): AccountPnL => ({ dailyPnL: null, unrealizedPnL: null, realizedPnL: null }),
  getOrderFillPrice: () => undefined,
  getOrderFillPriceWithFallback: async () => undefined,
  onConnectionChange: () => (() => {}),
  connect: () => {},
  disconnect: () => {},
  acquireRequestSlot: async () => {},
  releaseRequestSlot: () => {},
  registerReqErrorCallback: () => {},
  unregisterReqErrorCallback: () => {},
  createStockContract: (symbol: string) => ({
    symbol: symbol.toUpperCase(),
    secType: SecType.STK,
    exchange: 'SMART',
    currency: 'USD',
  }),
  searchContract: async () => null,
  placeBracketOrder: () => Promise.reject(new Error('Live connection not initialized')),
  placeMarketOrder: () => Promise.reject(new Error('Live connection not initialized')),
  placeOptionsOrder: () => Promise.reject(new Error('Live connection not initialized')),
  placeCalendarSpreadOrder: () => Promise.reject(new Error('Live connection not initialized')),
  placeVerticalSpreadOrder: () => Promise.reject(new Error('Live connection not initialized')),
  cancelOrder: () => { throw new Error('Live connection not initialized'); },
  requestPositions: () => Promise.reject(new Error('Live connection not initialized')),
  requestOpenOrders: () => Promise.reject(new Error('Live connection not initialized')),
  resolveOptionConId: async () => null,
}) as unknown as IBConnection;

export function getLiveConnection(): IBConnection {
  if (!liveConn) return disconnectedStub;
  return liveConn;
}

export function getConnectionForAccount(accountType: AccountType): IBConnection {
  return accountType === 'live' ? getLiveConnection() : getPaperConnection();
}

// ══════════════════════════════════════════════════════════
// ── Backward Compatibility Layer ─────────────────────────
// All existing module-level exports delegate to paperConn.
// Existing callers (scheduler.ts, routes, etc.) continue to
// work with ZERO changes during the transition.
// ══════════════════════════════════════════════════════════

export function isConnected(): boolean { return paperConn?.isConnected() ?? false; }
export function getAccounts(): string[] { return paperConn?.getAccounts() ?? []; }
export function getDefaultAccount(): string | null { return paperConn?.getDefaultAccount() ?? null; }
export function getIBApi(): IBApi | null { return paperConn?.getIBApi() ?? null; }
export function getNextOrderId(): number { return paperConn?.getNextOrderId() ?? 0; }

export function onConnectionChange(fn: (state: boolean) => void): () => void {
  if (!paperConn) return () => {};
  return paperConn.onConnectionChange(fn);
}

export function getDailyPnL(): AccountPnL {
  return paperConn?.getDailyPnL() ?? { dailyPnL: null, unrealizedPnL: null, realizedPnL: null };
}

export function getOrderFillPrice(orderId: number): number | undefined {
  return paperConn?.getOrderFillPrice(orderId);
}

export async function getOrderFillPriceWithFallback(orderId: number): Promise<number | undefined> {
  if (!paperConn) return undefined;
  return paperConn.getOrderFillPriceWithFallback(orderId);
}

export async function acquireRequestSlot(): Promise<void> {
  if (!paperConn) return;
  return paperConn.acquireRequestSlot();
}

export function releaseRequestSlot(): void {
  paperConn?.releaseRequestSlot();
}

export function registerReqErrorCallback(reqId: number, cb: (code: number, msg: string) => void): void {
  paperConn?.registerReqErrorCallback(reqId, cb);
}

export function unregisterReqErrorCallback(reqId: number): void {
  paperConn?.unregisterReqErrorCallback(reqId);
}

export function connect(): void {
  if (paperConn) {
    paperConn.connect();
  } else {
    paperConn = new IBConnection('paper', 4002, 1);
    paperConn.connect();
  }
}

export function createStockContract(symbol: string): Contract {
  return paperConn?.createStockContract(symbol) ?? {
    symbol: symbol.toUpperCase(),
    secType: SecType.STK,
    exchange: 'SMART',
    currency: 'USD',
  };
}

export async function searchContract(symbol: string): Promise<ContractSearchResult | null> {
  if (!paperConn) throw new Error('Not connected to IB Gateway');
  return paperConn.searchContract(symbol);
}

export function placeBracketOrder(params: BracketOrderParams): Promise<BracketOrderResult> {
  if (!paperConn) return Promise.reject(new Error('Not connected to IB Gateway'));
  return paperConn.placeBracketOrder(params);
}

export function placeMarketOrder(params: MarketOrderParams): Promise<MarketOrderResult> {
  if (!paperConn) return Promise.reject(new Error('Not connected to IB Gateway'));
  return paperConn.placeMarketOrder(params);
}

export function cancelOrder(orderId: number): void {
  if (!paperConn) throw new Error('Not connected to IB Gateway');
  paperConn.cancelOrder(orderId);
}

export function requestPositions(): Promise<PositionData[]> {
  if (!paperConn) return Promise.reject(new Error('Not connected to IB Gateway'));
  return paperConn.requestPositions();
}

export function requestOpenOrders(): Promise<OpenOrderData[]> {
  if (!paperConn) return Promise.reject(new Error('Not connected to IB Gateway'));
  return paperConn.requestOpenOrders();
}

export function placeOptionsOrder(params: OptionsOrderParams): Promise<OptionsOrderResult> {
  if (!paperConn) return Promise.reject(new Error('Not connected to IB Gateway'));
  return paperConn.placeOptionsOrder(params);
}

export async function placeCalendarSpreadOrder(
  params: CalendarSpreadOrderParams,
): Promise<CalendarSpreadOrderResult> {
  if (!paperConn) throw new Error('Not connected to IB Gateway');
  return paperConn.placeCalendarSpreadOrder(params);
}

export async function placeVerticalSpreadOrder(
  params: VerticalSpreadOrderParams,
): Promise<VerticalSpreadOrderResult> {
  if (!paperConn) throw new Error('Not connected to IB Gateway');
  return paperConn.placeVerticalSpreadOrder(params);
}

export function disconnect(): void {
  paperConn?.disconnect();
  liveConn?.disconnect();
}
