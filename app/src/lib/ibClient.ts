/**
 * Interactive Brokers Client Portal Gateway REST client.
 *
 * Talks to the CPGW running locally at https://localhost:5000.
 * All calls go through the browser — no backend service needed.
 *
 * Setup: download CPGW from IB, run it, login via browser once/day.
 * CORS: configure conf.yaml to allow localhost:5173.
 */

// ── Configuration ────────────────────────────────────────

const IB_BASE_URL = 'https://localhost:5000/v1/api';

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

/** Check if CPGW session is alive */
export async function checkAuthStatus(): Promise<IBAuthStatus> {
  try {
    return await ibFetch<IBAuthStatus>('/iserver/auth/status', {
      method: 'POST',
    });
  } catch {
    return { authenticated: false, connected: false, competing: false, fail: 'Gateway unreachable' };
  }
}

/** Keep session alive (call every 60s while auto-trading) */
export async function pingSession(): Promise<boolean> {
  try {
    await ibFetch('/tickle', { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

/** Re-authenticate (triggers SSO) */
export async function reauthenticate(): Promise<void> {
  await ibFetch('/iserver/reauthenticate', { method: 'POST' });
}

// ── Accounts ─────────────────────────────────────────────

/** Get all accounts (returns paper + live if both exist) */
export async function getAccounts(): Promise<string[]> {
  const data = await ibFetch<{ accounts: string[] }>('/iserver/accounts');
  return data.accounts ?? [];
}

// ── Contract Search ──────────────────────────────────────

/** Search for a stock contract by ticker symbol */
export async function searchContract(symbol: string): Promise<IBContractSearch | null> {
  const results = await ibFetch<IBContractSearch[]>(
    `/iserver/secdef/search`,
    {
      method: 'POST',
      body: JSON.stringify({ symbol: symbol.toUpperCase(), secType: 'STK' }),
    }
  );

  if (!results || results.length === 0) return null;

  // Prefer US-listed stock
  const usStock = results.find(
    (r) => r.secType === 'STK' && (r.exchange === 'NASDAQ' || r.exchange === 'NYSE' || r.exchange === 'SMART')
  );
  return usStock ?? results[0];
}

// ── Orders ───────────────────────────────────────────────

/**
 * Place a bracket order (entry + stop loss + take profit).
 * IB's bracket order format: parent + 2 child orders.
 */
export async function placeBracketOrder(params: {
  accountId: string;
  conid: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  tif?: 'DAY' | 'GTC';
}): Promise<IBOrderReply[]> {
  const { accountId, conid, side, quantity, entryPrice, stopLoss, takeProfit, tif = 'GTC' } = params;

  // Opposite side for closing orders
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

  const orders = {
    orders: [
      {
        // Parent: entry limit order
        acctId: accountId,
        conid,
        orderType: 'LMT',
        side,
        quantity,
        price: entryPrice,
        tif,
        outsideRTH: false,
        isSingleGroup: true,
        // Children follow
        childOrders: [
          {
            // Stop loss
            acctId: accountId,
            conid,
            orderType: 'STP',
            side: closeSide,
            quantity,
            price: stopLoss,
            tif,
          },
          {
            // Take profit
            acctId: accountId,
            conid,
            orderType: 'LMT',
            side: closeSide,
            quantity,
            price: takeProfit,
            tif,
          },
        ],
      },
    ],
  };

  return await ibFetch<IBOrderReply[]>(
    `/iserver/account/${accountId}/orders`,
    { method: 'POST', body: JSON.stringify(orders) }
  );
}

/** Place a simple market order (for closing positions) */
export async function placeMarketOrder(params: {
  accountId: string;
  conid: number;
  side: 'BUY' | 'SELL';
  quantity: number;
}): Promise<IBOrderReply[]> {
  const { accountId, conid, side, quantity } = params;

  return await ibFetch<IBOrderReply[]>(
    `/iserver/account/${accountId}/orders`,
    {
      method: 'POST',
      body: JSON.stringify({
        orders: [{
          acctId: accountId,
          conid,
          orderType: 'MKT',
          side,
          quantity,
          tif: 'DAY',
        }],
      }),
    }
  );
}

/** Confirm an order reply (IB sometimes asks for confirmation) */
export async function confirmOrder(replyId: string): Promise<IBOrderReply[]> {
  return await ibFetch<IBOrderReply[]>(
    `/iserver/reply/${replyId}`,
    { method: 'POST', body: JSON.stringify({ confirmed: true }) }
  );
}

/** Cancel an order */
export async function cancelOrder(accountId: string, orderId: string): Promise<void> {
  await ibFetch(`/iserver/account/${accountId}/order/${orderId}`, {
    method: 'DELETE',
  });
}

// ── Positions ────────────────────────────────────────────

/** Get all open positions */
export async function getPositions(accountId: string): Promise<IBPosition[]> {
  const pageId = 0;
  const data = await ibFetch<IBPosition[]>(
    `/portfolio/${accountId}/positions/${pageId}`
  );
  return data ?? [];
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
  const data = await ibFetch<{ orders: IBLiveOrder[] }>('/iserver/account/orders');
  return data.orders ?? [];
}

// ── Market Data ──────────────────────────────────────────

/** Get a quick snapshot of market data for a conid */
export async function getMarketDataSnapshot(conids: number[]): Promise<Record<string, unknown>[]> {
  const fields = '31,84,86'; // last price, bid, ask
  return await ibFetch<Record<string, unknown>[]>(
    `/iserver/marketdata/snapshot?conids=${conids.join(',')}&fields=${fields}`
  );
}
