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

import { IBApi, EventName, Contract, Order, OrderAction, OrderType, SecType, TimeInForce, OptionType, ScanCode, LocationCode, Instrument } from '@stoqey/ib';
import type { ScannerSubscription } from '@stoqey/ib';
export { LocationCode } from '@stoqey/ib';
import { insertIbFill, updateIbFillCommission, getTodayFillPrices, getFillPriceByOrderId, getOpenOrderIdToSymbol, saveConfigPartial, createAutoTradeEvent } from './lib/supabase.js';
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
  timedOut?: boolean; // true = IB did not ACK within timeout; treat as SUBMITTED pending reconciliation
}

export interface MarketOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** Pre-allocate the IB order ID before calling placeMarketOrder, so callers can stamp
   *  ib_close_order_id on the paper_trade BEFORE placing the order. This prevents the
   *  DB trigger from creating ghost records when the fill arrives before recordTradeClose runs. */
  preAllocatedOrderId?: number;
  /** Use IB's Adaptive Algo instead of a plain MKT order.
   *  Recommended for sub-$1 stocks to avoid IB error 2161
   *  (regulatory price cap on plain market orders). */
  useAdaptiveAlgo?: boolean;
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
  /** When provided, IB routes by conId rather than symbol/strike/expiry — avoids
   *  code=200 rejections when the working expiry offset differs from the stored date. */
  conId?: number;
}

export interface OptionsOrderResult {
  orderId: number;
  avgFillPrice: number;
  filledQty: number;
  /** True when the order was placed but no fill/reject arrived before the timeout.
   *  The order is live in IB as a pending DAY order — callers must record it as
   *  SUBMITTED (not FILLED) and wait for the execDetails callback to update status. */
  timedOut?: boolean;
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
  private _readyForOrdersAt = 0; // epoch ms — orders blocked until this time after each connect
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
  /** Persists orderId → ticker even after the order callback resolves — used as
   *  fallback in execDetails when IB sends contract.symbol = '' */
  private _orderIdToSymbol = new Map<number, string>();

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
  isReadyForOrders(): boolean { return this._connected && Date.now() >= this._readyForOrdersAt; }
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

    // Reconcile any SUBMITTED paper_trades that were cancelled while we were offline.
    // Give IB 15s to finish delivering all open orders after a fresh connection —
    // the 2s window was too short and caused false cancellations of legitimately open orders.
    setTimeout(() => this._reconcileSubmittedOrders(), 15000);
  }

  private _reconcileSubmittedOrders(): void {
    if (!this.ib) return;
    const emitter = this.ib as unknown as { on: Function; off: Function };

    const openIbOrderIds = new Set<number>();
    const orderHandler = (orderId: number) => { openIbOrderIds.add(orderId); };
    const endHandler = () => {
      emitter.off(EventName.openOrder, orderHandler);
      emitter.off(EventName.openOrderEnd, endHandler);

      import('./lib/supabase.js').then(async ({ getSupabase }) => {
        // Only reconcile orders submitted more than 10 minutes ago — very recent orders
        // may not yet be visible in reqAllOpenOrders on a fresh connection.
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const sb = getSupabase();

        const { data, error } = await sb
          .from('paper_trades')
          .select('id, ticker, ib_order_id')
          .eq('status', 'SUBMITTED')
          .not('ib_order_id', 'is', null)
          .lt('opened_at', tenMinutesAgo);

        if (error || !data?.length) return;

        const missingFromIb = data.filter(t => !openIbOrderIds.has(Number(t.ib_order_id)));
        if (!missingFromIb.length) {
          console.log(`${this.tag} Reconcile: all SUBMITTED orders still open in IB`);
          return;
        }

        // Before cancelling, check ib_fills — a filled order is no longer "open"
        // in IB's open-orders list, so we must not treat it as cancelled.
        const missingOrderIds = missingFromIb.map(t => Number(t.ib_order_id));
        const { data: fills } = await sb
          .from('ib_fills')
          .select('order_id')
          .in('order_id', missingOrderIds);

        const filledOrderIds = new Set((fills ?? []).map(f => Number(f.order_id)));

        const toActivate = missingFromIb.filter(t => filledOrderIds.has(Number(t.ib_order_id)));
        const toCancel   = missingFromIb.filter(t => !filledOrderIds.has(Number(t.ib_order_id)));

        if (toActivate.length) {
          console.log(`${this.tag} Reconcile: ${toActivate.length} order(s) already filled in IB — marking FILLED: ${toActivate.map(t => `${t.ticker}#${t.ib_order_id}`).join(', ')}`);
          await sb
            .from('paper_trades')
            .update({ status: 'FILLED' })
            .in('ib_order_id', toActivate.map(t => t.ib_order_id!))
            .eq('status', 'SUBMITTED');
        }

        if (toCancel.length) {
          console.log(`${this.tag} Reconcile: cancelling ${toCancel.length} order(s) missing from IB (no fill): ${toCancel.map(t => `${t.ticker}#${t.ib_order_id}`).join(', ')}`);
          await sb
            .from('paper_trades')
            .update({ status: 'CANCELLED', close_reason: 'IB order cancelled (reconciled at startup)' })
            .in('ib_order_id', toCancel.map(t => t.ib_order_id!))
            .eq('status', 'SUBMITTED');
        }
      }).catch(() => {});
    };

    emitter.on(EventName.openOrder, orderHandler);
    emitter.on(EventName.openOrderEnd, endHandler);
    try {
      this.ib.reqAllOpenOrders();
      console.log(`${this.tag} Reconcile: checking SUBMITTED orders vs IB open orders...`);
    } catch {
      emitter.off(EventName.openOrder, orderHandler);
      emitter.off(EventName.openOrderEnd, endHandler);
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
      // Hold off new order placement for 60s after each connect — IB paper accounts
      // show "connected" before they're fully ready to ack bracket orders.
      this._readyForOrdersAt = Date.now() + 60_000;
      this.reconnectAttempts = 0;
      ib.reqManagedAccts();
      ib.reqIds();
      // Switch to delayed market data (type 3) BEFORE notifying the scheduler so
      // options greeks reqMktData calls succeed on paper accounts without live
      // data subscriptions. Delayed data includes Greeks and bid/ask; type 3
      // falls back to frozen prices when the market is closed.
      (ib as unknown as { reqMarketDataType: (type: number) => void }).reqMarketDataType(3);
      console.log(`${this.tag} Market data type set to delayed (type 3)`);
      this.connectionListeners.forEach(fn => fn(true));
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

        // Code 399 = "order repriced to avoid crossing a resting order" — advisory WARNING.
        // Code 2161 = IB regulatory price cap — IB converts MKT to a capped limit order but
        //   the order stays ALIVE and fills when the market cooperates. Rejecting here causes
        //   placeMarketOrder to throw before createPaperTrade runs, so the IB fill arrives but
        //   no paper_trade record is ever created (confirmed: XOS on 2026-06-03, 869 shares).
        // Solution for both: swallow the advisory, keep the callback alive, let fill resolve it.
        if (code === 399 || code === 2161) {
          console.warn(`${this.tag} Order ${reqId} (${pending.symbol}) advisory code=${code}: ${err.message} — order still live, waiting for fill`);
          return;
        }

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
      // IB broadcasts nextValidId proactively (not just on reqIds()). Only accept
      // the new value when it's strictly higher than our current counter — otherwise
      // IB's stale broadcast would reset our counter backwards and cause duplicate
      // order-ID rejections on the next placeOrder call.
      if (orderId > this._nextOrderId) {
        this._nextOrderId = orderId;
        console.log(`${this.tag} Next valid order ID: ${this._nextOrderId}`);
      } else {
        console.log(`${this.tag} nextValidId broadcast ${orderId} ignored (current counter already at ${this._nextOrderId})`);
      }
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

      if (status === 'Cancelled' || status === 'Inactive') {
        if (this._pendingOrderCallbacks.has(orderId)) {
          const pending = this._pendingOrderCallbacks.get(orderId)!;
          clearTimeout(pending.timer);
          this._pendingOrderCallbacks.delete(orderId);
          console.error(`${this.tag} Order ${orderId} (${pending.symbol}) ${status}`);
          pending.reject(new Error(`IB order ${orderId} (${pending.symbol}) ${status}`));
        } else if (status === 'Cancelled') {
          // Only hard-cancel in DB for true Cancelled status — never for Inactive,
          // which is a normal transient state for GTC orders outside market hours.
          console.log(`${this.tag} Order ${orderId} Cancelled by IB/user — syncing to DB`);
          import('./lib/supabase.js').then(({ getSupabase }) => {
            getSupabase()
              .from('paper_trades')
              .update({ status: 'CANCELLED', close_reason: 'IB order cancelled' })
              .eq('ib_order_id', String(orderId))
              .eq('status', 'SUBMITTED')
              .then(({ error }) => {
                if (error) console.warn(`${this.tag} Failed to sync cancellation for order ${orderId}: ${error.message}`);
                else console.log(`${this.tag} Order ${orderId} marked CANCELLED in DB`);
              });
          }).catch(() => {});
        }
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ib as any).on(EventName.execDetails, (_reqId: number, contract: any, execution: any) => {
      const orderId = execution?.orderId ?? execution?.order?.orderId;
      const price = execution?.price ?? execution?.avgPrice;
      const qty = execution?.shares ?? execution?.cumQty ?? 0;
      const execId = execution?.execId ?? null;
      const side = execution?.side ?? '';
      // IB sometimes sends contract.symbol = '' for bracket TP/SL fills.
      // Fall back to our persistent orderIdToSymbol map registered at order placement.
      const ticker = (contract?.symbol || this._orderIdToSymbol.get(orderId) || '');

      if (orderId && price > 0) {
        this._orderFillPrices.set(orderId, price);
        console.log(`${this.tag} ExecDetails: order ${orderId} ${side} ${qty}x ${ticker || '?'} @ $${price.toFixed(4)} (execId=${execId})`);
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
    this.hydrateOrderIdToSymbol().catch(() => {});

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

  private async hydrateOrderIdToSymbol(): Promise<void> {
    try {
      const map = await getOpenOrderIdToSymbol(this.label);
      let count = 0;
      for (const [orderId, ticker] of map) {
        if (!this._orderIdToSymbol.has(orderId)) {
          this._orderIdToSymbol.set(orderId, ticker);
          count++;
        }
      }
      if (count > 0) {
        console.log(`${this.tag} Hydrated ${count} orderId→symbol mappings from DB`);
      }
    } catch (err) {
      console.warn(`${this.tag} Failed to hydrate orderId→symbol:`, err instanceof Error ? err.message : err);
    }
  }

  // ── Contract Helper ──────────────────────────────────

  // Tickers that IB's SMART router fails to disambiguate without an explicit primary exchange.
  // Add a ticker here if you see error code 200 "No security definition found" for a US stock.
  private static readonly PRIMARY_EXCH_OVERRIDES: Record<string, string> = {
    ASTS: 'NASDAQ',
  };

  createStockContract(symbol: string): Contract {
    const upper = symbol.toUpperCase();
    const primaryExch = IBConnection.PRIMARY_EXCH_OVERRIDES[upper];
    return {
      symbol: upper,
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
      ...(primaryExch ? { primaryExch } : {}),
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

  // ── Contract Resolution ──────────────────────────────
  // For tickers in PRIMARY_EXCH_OVERRIDES, pre-resolve the conId via searchContract.
  // A conId-based contract bypasses all symbol/exchange ambiguity in IB SMART routing.
  // Falls back to the symbol-based contract if searchContract returns null.

  private async resolveContractForOrder(symbol: string): Promise<Contract> {
    const upper = symbol.toUpperCase();
    if (IBConnection.PRIMARY_EXCH_OVERRIDES[upper]) {
      try {
        const resolved = await this.searchContract(upper);
        if (resolved?.conId) {
          console.log(`${this.tag} Resolved ${upper} conId=${resolved.conId} (${resolved.primaryExch}) — using conId contract`);
          return { conId: resolved.conId, exchange: 'SMART', currency: 'USD' };
        }
        console.warn(`${this.tag} searchContract returned null for ${upper} — falling back to symbol contract`);
      } catch (err) {
        console.warn(`${this.tag} searchContract failed for ${upper}: ${err instanceof Error ? err.message : err} — falling back to symbol contract`);
      }
    }
    return this.createStockContract(upper);
  }

  // ── Place Bracket Order ──────────────────────────────

  async placeBracketOrder(params: BracketOrderParams): Promise<BracketOrderResult> {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }
    if (!this.isReadyForOrders()) {
      const waitSec = Math.ceil((this._readyForOrdersAt - Date.now()) / 1000);
      throw new Error(`${this.tag} IB connection warming up — orders blocked for ${waitSec}s more after reconnect`);
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
        throw new Error(`DAY order rejected: market not open (${etStr}) — order would be invalid before 9:30 AM ET`);
      }
    }

    const contract = await this.resolveContractForOrder(symbol);
    return new Promise((resolve, reject) => {
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

      // Wait for IB to acknowledge the parent order (PreSubmitted or Submitted)
      // before resolving. We resolve with timedOut=true if IB doesn't respond in
      // time — the caller saves a SUBMITTED paper_trade so the reconciler can
      // verify/close it later. We never reject on timeout alone because IB paper
      // frequently accepts bracket orders but sends the ack >30s later, creating
      // orphaned IB positions with no corresponding DB record.
      // Track all three order IDs so execDetails can look up ticker by orderId
      // when IB sends contract.symbol = '' (happens ~5% of fills).
      this._orderIdToSymbol.set(parentId, symbol);
      this._orderIdToSymbol.set(tpId, symbol);
      this._orderIdToSymbol.set(slId, symbol);

      let ackResolved = false;
      const ACK_TIMEOUT_MS = 30_000;

      const ackTimer = setTimeout(() => {
        if (ackResolved) return;
        ackResolved = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.ib as any).off(EventName.orderStatus, onOrderStatus);
        console.warn(`${this.tag} Bracket order ${parentId} (${symbol}) not acknowledged within ${ACK_TIMEOUT_MS / 1000}s — saving as SUBMITTED for reconciler`);
        resolve({ parentOrderId: parentId, takeProfitOrderId: tpId, stopLossOrderId: slId, timedOut: true });
      }, ACK_TIMEOUT_MS);

      const onOrderStatus = (ordId: number, status: string) => {
        if (ordId !== parentId || ackResolved) return;
        if (status === 'PreSubmitted' || status === 'Submitted' || status === 'Filled') {
          ackResolved = true;
          clearTimeout(ackTimer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.ib as any).off(EventName.orderStatus, onOrderStatus);
          console.log(`${this.tag} Bracket order acknowledged by IB: ${side} ${quantity}x ${symbol} entry=$${entryPrice} tp=$${takeProfit} sl=$${stopLoss} (status=${status})`);
          resolve({ parentOrderId: parentId, takeProfitOrderId: tpId, stopLossOrderId: slId });
        } else if (status === 'Cancelled' || status === 'Inactive') {
          ackResolved = true;
          clearTimeout(ackTimer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.ib as any).off(EventName.orderStatus, onOrderStatus);
          reject(new Error(`Bracket order ${parentId} (${symbol}) rejected by IB — status: ${status}`));
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.ib as any).on(EventName.orderStatus, onOrderStatus);

      try {
        this.ib!.placeOrder(parentId, contract, parentOrder);
        this.ib!.placeOrder(tpId, contract, takeProfitOrder);
        this.ib!.placeOrder(slId, contract, stopLossOrder);
        console.log(`${this.tag} Bracket order dispatched: ${side} ${quantity}x ${symbol} entry=$${entryPrice} tp=$${takeProfit} sl=$${stopLoss} (parentId=${parentId}) — awaiting IB ack...`);
        // Force IB to emit orderStatus for all submitted orders — paper account
        // sometimes doesn't proactively push status back in degraded sessions.
        setTimeout(() => { if (!ackResolved) this.ib?.reqAllOpenOrders(); }, 2000);
      } catch (err) {
        ackResolved = true;
        clearTimeout(ackTimer);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.ib as any).off(EventName.orderStatus, onOrderStatus);
        reject(err);
      }
    });
  }

  // ── Place Market Order ───────────────────────────────

  async placeMarketOrder(params: MarketOrderParams): Promise<MarketOrderResult> {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }

    const { symbol, side, quantity, useAdaptiveAlgo, preAllocatedOrderId } = params;
    const contract = await this.resolveContractForOrder(symbol);

    return new Promise((resolve, reject) => {
      const orderId = preAllocatedOrderId ?? this.getNextOrderId();

      const order: Order = {
        action: side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
        orderType: OrderType.MKT,
        totalQuantity: quantity,
        tif: TimeInForce.DAY,
        transmit: true,
        // IB Adaptive Algo: avoids error 2161 (regulatory price cap) on sub-$1 stocks.
        // Set algoStrategy="Adaptive" + adaptivePriority="Urgent" so it fills quickly
        // while still routing through IB's algo infrastructure (bypassing the plain
        // MKT order price cap). Confirmed via IB TWS API docs: ibalgos.html
        ...(useAdaptiveAlgo ? {
          algoStrategy: 'Adaptive',
          algoParams: [{ tag: 'adaptivePriority', value: 'Urgent' }],
        } : {}),
      };

      const timer = setTimeout(() => {
        this._pendingOrderCallbacks.delete(orderId);
        const msg = `IB order ${orderId} (${symbol} ${side} ${quantity}) timed out after ${MKT_ORDER_TIMEOUT_MS / 1000}s — no fill/error received`;
        console.error(`${this.tag} ${msg}`);
        reject(new Error(msg));
      }, MKT_ORDER_TIMEOUT_MS);

      this._pendingOrderCallbacks.set(orderId, { resolve, reject, timer, symbol });
      this._orderIdToSymbol.set(orderId, symbol);

      try {
        this.ib!.placeOrder(orderId, contract, order);
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

      // When a conId is provided (from resolveOptionConId), use it as the sole
      // contract identifier — IB resolves the exact series from its database,
      // bypassing any symbol/strike/expiry mismatch (e.g. settlement date offset).
      const contract: Contract = params.conId
        ? { conId: params.conId, exchange: 'SMART', currency: 'USD' }
        : {
            symbol: symbol.toUpperCase(),
            secType: SecType.OPT,
            exchange: 'SMART',
            currency: 'USD',
            strike,
            right: right === 'P' ? OptionType.Put : OptionType.Call,
            lastTradeDateOrContractMonth: expiry,
            multiplier: 100,
            // tradingClass intentionally omitted — let IB resolve by symbol/strike/expiry.
            // Hardcoding the symbol as tradingClass causes rejections for tickers where
            // IB's internal trading class differs (e.g. ADI, DOCU, RBRK).
            ...(params.tradingClass ? { tradingClass: params.tradingClass } : {}),
          };

      const orderId = this.getNextOrderId();

      const orderAction = params.action === 'BUY' ? OrderAction.BUY : OrderAction.SELL;

      const order: Order = {
        action: orderAction,
        orderType: OrderType.LMT,
        totalQuantity: contracts,
        lmtPrice: limitPrice,
        tif: TimeInForce.GTC,
        transmit: true,
        ...(account ? { account } : {}),
      };

      const timer = setTimeout(async () => {
        this._pendingOrderCallbacks.delete(orderId);
        // Before declaring a timeout failure, check ib_fills — the order may have
        // filled in IB but the execDetails callback arrived after our deadline.
        try {
          const { getSupabase } = await import('./lib/supabase.js');
          const sb = getSupabase();
          // Give IB a few extra seconds to write the fill, then check
          await new Promise(r => setTimeout(r, 5_000));
          const { data: fillRow } = await sb
            .from('ib_fills')
            .select('fill_price, quantity, filled_at')
            .eq('order_id', orderId)
            .not('fill_price', 'is', null)
            .maybeSingle();
          if (fillRow) {
            console.log(`${this.tag} Options order ${orderId} (${symbol}) timed out locally but fill found in ib_fills — resolving`);
            resolve({ orderId, avgFillPrice: (fillRow as { fill_price: number; quantity: number; filled_at: string }).fill_price, filledQty: (fillRow as { fill_price: number; quantity: number; filled_at: string }).quantity });
            return;
          }
        } catch {
          // fall through to reject
        }
        const msg = `IB options order ${orderId} (${symbol} $${strike}${right}) timed out after ${OPT_ORDER_TIMEOUT_MS / 1000}s — no fill/reject received`;
        console.error(`${this.tag} ${msg}`);
        // Resolve with a sentinel so the caller can save orderId as SUBMITTED
        // rather than leaving the trade fully orphaned. The fill will arrive
        // via execDetails when the order eventually fills (e.g. next market open).
        resolve({ orderId, avgFillPrice: 0, filledQty: 0, timedOut: true });
      }, OPT_ORDER_TIMEOUT_MS);

      this._pendingOrderCallbacks.set(orderId, { resolve, reject, timer, symbol });
      this._orderIdToSymbol.set(orderId, symbol);

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
    onIbError?: (error: string) => void,
  ): Promise<{ conId: number; resolvedExpiry: string } | null> {
    if (!this.ib || !this._connected) return null;

    // Helper that fires one reqContractDetails request and waits up to 8s.
    // We deliberately omit `tradingClass` — setting it causes exact-match failures
    // for tickers where IB's internal trading class differs from the ticker symbol
    // (e.g. ADI, DOCU, RBRK). IB resolves to the correct series without it.
    const tryResolve = async (expDate: string): Promise<number | null> => {
      await this.acquireRequestSlot();
      try {
        return await new Promise<number | null>((resolve) => {
          const reqId = this.getNextOrderId();
          const emitter = this.ib! as unknown as NodeJS.EventEmitter;
          let resolved = false;

          const finish = (conId: number | null) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            this.unregisterReqErrorCallback(reqId);
            resolve(conId);
          };

          const timeout = setTimeout(() => finish(null), 8_000);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const onDetails = (_rId: number, details: any) => {
            // Filter to our reqId to avoid cross-wiring concurrent requests
            if (_rId !== reqId) return;
            emitter.removeListener(EventName.contractDetails, onDetails);
            finish(details?.contract?.conId ?? null);
          };
          emitter.on(EventName.contractDetails, onDetails);

          this.registerReqErrorCallback(reqId, (code, msg) => {
            onIbError?.(`IB error ${code}: ${msg}`);
            emitter.removeListener(EventName.contractDetails, onDetails);
            finish(null);
          });

          this.ib!.reqContractDetails(reqId, {
            symbol: symbol.toUpperCase(),
            secType: SecType.OPT,
            // exchange intentionally omitted — IB returns the canonical contract
            // definition across all exchanges; SMART routing is applied at order time
            currency: 'USD',
            strike,
            right: right === 'P' ? OptionType.Put : OptionType.Call,
            lastTradeDateOrContractMonth: expDate,
            multiplier: 100,
            // tradingClass intentionally omitted — let IB resolve by symbol
          });
        });
      } finally {
        this.releaseRequestSlot();
      }
    };

    // Try the exact expiry first, then ±1 day (IB settlement vs last-trade-date
    // differs by a day for monthly options).
    const base = new Date(
      parseInt(expiry.slice(0, 4)),
      parseInt(expiry.slice(4, 6)) - 1,
      parseInt(expiry.slice(6, 8)),
    );
    for (const offsetDays of [0, 1, -1, 2]) {
      const d = new Date(base);
      d.setDate(d.getDate() + offsetDays);
      const candidate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const conId = await tryResolve(candidate);
      // Return both the conId AND the expiry date that actually worked —
      // callers must use resolvedExpiry (not the original) when placing orders
      // to avoid IB rejecting with code=200 "No security definition found".
      if (conId) return { conId, resolvedExpiry: candidate };
    }
    return null;
  }

  // ── Calendar Spread ──────────────────────────────────

  async placeCalendarSpreadOrder(
    params: CalendarSpreadOrderParams,
  ): Promise<CalendarSpreadOrderResult> {
    if (!this.ib || !this._connected) {
      throw new Error(`${this.tag} Not connected to IB Gateway`);
    }

    const { symbol, right, strike, frontExpiry, backExpiry, contracts, account } = params;

    const [frontResult, backResult] = await Promise.all([
      this.resolveOptionConId(symbol, right, strike, frontExpiry),
      this.resolveOptionConId(symbol, right, strike, backExpiry),
    ]);
    if (!frontResult || !backResult) {
      throw new Error(`Could not resolve conIds for ${symbol} ${strike}${right} ${frontExpiry}/${backExpiry}`);
    }
    const frontConId = frontResult.conId;
    const backConId = backResult.conId;

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
      tif: TimeInForce.GTC,
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

    const [sellResult, buyResult] = await Promise.all([
      this.resolveOptionConId(symbol, right, sellStrike, expiry),
      this.resolveOptionConId(symbol, right, buyStrike, expiry),
    ]);
    if (!sellResult || !buyResult) {
      throw new Error(`Could not resolve conIds for ${symbol} ${sellStrike}/${buyStrike}${right} ${expiry}`);
    }
    const sellConId = sellResult.conId;
    const buyConId = buyResult.conId;

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

    // IB BAG combo convention: lmtPrice is the NET PRICE from the buyer's perspective.
    // BUY combo (debit) → positive lmtPrice (buyer pays)
    // SELL combo (credit) → NEGATIVE lmtPrice (buyer receives, i.e. seller collects credit)
    // Sending a positive lmtPrice on a SELL order causes IB to silently zero it → Limit 0.00 → immediate cancel.
    const ibLmtPrice = spreadAction === OrderAction.SELL ? -limitPrice : limitPrice;

    const order: Order = {
      action: spreadAction,
      orderType: OrderType.LMT,
      totalQuantity: contracts,
      lmtPrice: ibLmtPrice,
      tif: TimeInForce.GTC,
      transmit: true,
      // NonGuaranteed allows IB SMART routing to fill each leg independently,
      // greatly improving fill probability for multi-leg options orders.
      smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '1' }],
      ...(account ? { account } : {}),
    };

    try {
      this.ib.placeOrder(orderId, contract, order);
      console.log(`${this.tag} Credit spread placed: ${spreadActionLabel} ${contracts}x ${symbol} ${sellStrike}/${buyStrike}${right} ${expiry} @ $${limitPrice} ${creditDebitLabel} (IB lmtPrice=${ibLmtPrice}, orderId=${orderId})`);
      return { orderId };
    } catch (err) {
      throw err;
    }
  }

  // ── Market Scanner ───────────────────────────────────

  /**
   * Fetch top % gainers from IB's built-in market scanner.
   * Replaces Yahoo Finance screener — no external auth needed.
   * Returns tickers with IB-provided % gain distance string parsed as number.
   */
  async scanTopGainers(opts: {
    abovePrice?: number;
    belowPrice?: number;
    aboveVolume?: number;
    numberOfRows?: number;
    openGap?: boolean;
    locationCode?: LocationCode;
  } = {}): Promise<Array<{ ticker: string; distancePct: number | null }>> {
    if (!this.ib || !this._connected) return [];

    const reqId = this.getNextOrderId();
    const params: ScannerSubscription = {
      instrument: Instrument.STK,
      locationCode: opts.locationCode ?? LocationCode.STK_US_MAJOR,
      scanCode: opts.openGap ? ScanCode.TOP_OPEN_PERC_GAIN : ScanCode.TOP_PERC_GAIN,
      numberOfRows: opts.numberOfRows ?? 30,
      ...(opts.abovePrice != null ? { abovePrice: opts.abovePrice } : {}),
      ...(opts.belowPrice != null ? { belowPrice: opts.belowPrice } : {}),
      ...(opts.aboveVolume != null ? { aboveVolume: opts.aboveVolume } : {}),
    };

    return new Promise(resolve => {
      const results: Array<{ ticker: string; distancePct: number | null }> = [];
      const emitter = this.ib! as unknown as NodeJS.EventEmitter;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        emitter.removeListener(EventName.scannerData, onData);
        emitter.removeListener(EventName.scannerDataEnd, onEnd);
        try { this.ib?.cancelScannerSubscription(reqId); } catch { /* ignore */ }
        resolve(results);
      };

      const timeout = setTimeout(finish, 10_000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onData = (rId: number, _rank: number, contractDetails: any, distance: string) => {
        if (rId !== reqId) return;
        const ticker = contractDetails?.contract?.symbol as string | undefined;
        if (!ticker) return;
        const pct = parseFloat(distance);
        results.push({ ticker, distancePct: isNaN(pct) ? null : pct });
      };

      const onEnd = (rId: number) => {
        if (rId !== reqId) return;
        finish();
      };

      emitter.on(EventName.scannerData, onData);
      emitter.on(EventName.scannerDataEnd, onEnd);

      try {
        this.ib!.reqScannerSubscription(reqId, params);
      } catch (err) {
        console.warn(`${this.tag} scanTopGainers failed: ${err instanceof Error ? err.message : err}`);
        finish();
      }
    });
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
