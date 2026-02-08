/**
 * Broker API — frontend client for broker-connect and broker-sync Edge Functions.
 */
import { supabase } from './supabaseClient';

const BASE = import.meta.env.VITE_SUPABASE_URL;

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

export interface BrokerStatus {
  connected: boolean;
  lastSyncedAt: string | null;
  createdAt: string | null;
}

export interface SyncResult {
  positions: Array<{ ticker: string; name: string; shares: number; avgCost: number | null }>;
  stats: { added: number; updated: number; total: number };
}

export async function getBrokerStatus(): Promise<BrokerStatus> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/functions/v1/broker-connect`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'status' }),
  });
  if (!res.ok) throw new Error('Failed to check broker status');
  return res.json();
}

export async function connectBroker(): Promise<string> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/functions/v1/broker-connect`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'register' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to connect broker');
  return data.redirectUrl;
}

export async function getBrokerPortalUrl(): Promise<string> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/functions/v1/broker-connect`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'portal' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Failed to get portal URL');
  return data.redirectUrl;
}

export async function disconnectBroker(): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/functions/v1/broker-connect`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'disconnect' }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error ?? 'Failed to disconnect');
  }
}

export async function syncBrokerPositions(): Promise<SyncResult> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/functions/v1/broker-sync`, {
    method: 'POST', headers, body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Sync failed');
  return data;
}
