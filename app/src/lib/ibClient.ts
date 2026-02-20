/**
 * Interactive Brokers client — talks to the local auto-trader Node.js service.
 *
 * The auto-trader service (localhost:3001) bridges to IB Gateway via TWS API.
 * No daily login needed — IBC handles auto-login to IB Gateway.
 *
 * Architecture: Browser → auto-trader (REST, port 3001) → IB Gateway (TWS, port 4002)
 */

// ── Configuration ────────────────────────────────────────

const IB_BASE_URL = 'http://localhost:3001/api';

/** True when app can reach auto-trader at localhost:3001 (dev only) */
export function isLocalhost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location?.hostname ?? '';
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

// ── Types ────────────────────────────────────────────────

export interface IBAccount {
  id: string;
  accountId: string;
  type: string;       // e.g. "INDIVIDUAL"
  currency: string;
}

export interface IBPosition {
  acctId: string;
  conid: number;
  contractDesc: string;
  position: number;
  mktPrice: number;
  mktValue: number;
  avgCost: number;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  currency: string;
}

export interface IBOrderReply {
  order_id: string;
  order_status: string;
  encrypt_message?: string;
}

export interface IBOrderConfirmation {
  id: string;
  message: string[];
}

export interface IBAuthStatus {
  authenticated: boolean;
  connected: boolean;
  competing: boolean;
  fail?: string;
  message?: string;
}

export interface IBOrderRequest {
  acctId: string;
  conid: number;
  orderType: 'LMT' | 'MKT' | 'STP';
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;      // for LMT orders
  auxPrice?: number;   // for STP orders
  tif: 'DAY' | 'GTC';
  outsideRTH?: boolean;
}

export interface IBContractSearch {
  conid: number;
  companyHeader: string;
  companyName: string;
  symbol: string;
  secType: string;
  exchange: string;
}

// ── Helper ───────────────────────────────────────────────

async function ibFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${IB_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`IB API ${res.status}: ${text || res.statusText}`);
  }

  // Some endpoints return empty body
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

// ── Auth / Session ───────────────────────────────────────

/** Check if auto-trader service + IB Gateway are connected */
export async function checkAuthStatus(): Promise<IBAuthStatus> {
  try {
    return await ibFetch<IBAuthStatus>('/status');
  } catch {
    return { authenticated: false, connected: false, competing: false, fail: 'Auto-trader service unreachable' };
  }
}

/** Ping to verify service is alive (TWS API keeps its own connection) */
export async function pingSession(): Promise<boolean> {
  try {
    const status = await ibFetch<IBAuthStatus>('/status');
    return status.connected;
  } catch {
    return false;
  }
}

/** Re-authenticate — not needed with IBC auto-login, but kept for interface compatibility */
export async function reauthenticate(): Promise<void> {
  // No-op: IBC handles authentication automatically
}

// ── Accounts ─────────────────────────────────────────────

/** Get all accounts from the auto-trader service */
export async function getAccounts(): Promise<string[]> {
  const data = await ibFetch<{ accounts: string[] }>('/status');
  return data.accounts ?? [];
}

// ── Contract Search ──────────────────────────────────────

/** Search for a stock contract by ticker symbol */
export async function searchContract(symbol: string): Promise<IBContractSearch | null> {
  try {
    return await ibFetch<IBContractSearch>(`/contract/${symbol.toUpperCase()}`);
  } catch {
    return null;
  }
}

// ── Orders ───────────────────────────────────────────────

/**
 * Place a bracket order (entry + stop loss + take profit).
 * Sends to the auto-trader service which places via TWS API.
 *
 * Accepts both legacy (conid) and new (symbol) params.
 * The auto-trader service resolves contracts internally by symbol.
 */
export async function placeBracketOrder(params: {
  accountId: string;
  conid: number;
  symbol?: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  tif?: 'DAY' | 'GTC';
}): Promise<IBOrderReply[]> {
  const { symbol, side, quantity, entryPrice, stopLoss, takeProfit, tif = 'GTC' } = params;

  return await ibFetch<IBOrderReply[]>(
    '/order',
    {
      method: 'POST',
      body: JSON.stringify({
        symbol: symbol ?? '',
        side,
        quantity,
        entryPrice,
        stopLoss,
        takeProfit,
        tif,
      }),
    }
  );
}

/** Place a simple market order (for closing positions) */
export async function placeMarketOrder(params: {
  accountId: string;
  conid: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  symbol?: string;
}): Promise<IBOrderReply[]> {
  const { side, quantity, symbol } = params;

  return await ibFetch<IBOrderReply[]>(
    '/market-order',
    {
      method: 'POST',
      body: JSON.stringify({
        symbol: symbol ?? '',
        side,
        quantity,
      }),
    }
  );
}

/** Confirm an order reply — not needed with TWS API (auto-confirmed) */
export async function confirmOrder(_replyId: string): Promise<IBOrderReply[]> {
  // TWS API doesn't have the same confirmation flow as CPGW
  return [];
}

/** Cancel an order */
export async function cancelOrder(_accountId: string, orderId: string): Promise<void> {
  await ibFetch(`/order/${orderId}`, { method: 'DELETE' });
}

// ── Positions ────────────────────────────────────────────

/** Get all open positions */
export async function getPositions(_accountId: string): Promise<IBPosition[]> {
  return await ibFetch<IBPosition[]>('/positions');
}

// ── Orders List ──────────────────────────────────────────

export interface IBLiveOrder {
  orderId: number;
  conid: number;
  ticker: string;
  side: string;
  orderType: string;
  price: number;
  quantity: number;
  filledQuantity: number;
  status: string;
  parentId?: number;
}

/** Get live/working orders */
export async function getLiveOrders(): Promise<IBLiveOrder[]> {
  const data = await ibFetch<{ orders: IBLiveOrder[] }>('/orders');
  return data.orders ?? [];
}
