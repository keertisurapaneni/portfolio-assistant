/**
 * broker-sync — Fetches positions from all connected brokerage accounts via SnapTrade,
 * normalizes them, and upserts into the portfolios table.
 *
 * Returns: { positions, stats: { added, updated, total } }
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SNAPTRADE_BASE = 'https://api.snaptrade.com/api/v1';

// HMAC-SHA256 using Web Crypto API (native in Deno / Edge Functions)
async function hmacSha256Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// Deterministic JSON stringify with sorted keys (matches SnapTrade SDK)
function jsonSorted(obj: unknown): string {
  const allKeys: string[] = [];
  const seen: Record<string, boolean> = {};
  JSON.stringify(obj, (key, value) => {
    if (!(key in seen)) { allKeys.push(key); seen[key] = true; }
    return value;
  });
  allKeys.sort();
  return JSON.stringify(obj, allKeys);
}

async function snapTradeGet(
  path: string,
  clientId: string,
  consumerKey: string,
  query: Record<string, string>
) {
  // clientId + timestamp go as query params (per SnapTrade SDK)
  const timestamp = Math.round(Date.now() / 1000).toString();
  const allQuery: Record<string, string> = { clientId, timestamp, ...query };
  const params = new URLSearchParams(allQuery);
  const url = `${SNAPTRADE_BASE}${path}?${params}`;

  // Signature = HMAC-SHA256( JSON({content, path, query}), consumerKey )
  const requestPath = `/api/v1${path}`;
  const requestQuery = params.toString();
  const sigContent = jsonSorted({ content: null, path: requestPath, query: requestQuery });
  const signature = await hmacSha256Base64(encodeURI(consumerKey), sigContent);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Signature: signature,
  };

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SnapTrade GET ${path} failed (${res.status}): ${err}`);
  }
  return res.json();
}

interface NormalizedPosition {
  ticker: string;
  name: string;
  shares: number;
  avgCost: number | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify JWT
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // Get user from JWT
    const anonClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const clientId = Deno.env.get('SNAPTRADE_CLIENT_ID');
    const consumerKey = Deno.env.get('SNAPTRADE_CONSUMER_KEY');
    if (!clientId || !consumerKey) {
      return new Response(JSON.stringify({ error: 'SnapTrade not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get broker connection
    const { data: conn } = await sb
      .from('broker_connections')
      .select('snaptrade_user_id, snaptrade_user_secret')
      .eq('user_id', user.id)
      .single();

    if (!conn) {
      return new Response(JSON.stringify({ error: 'No broker connection. Connect a broker first.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const queryParams = {
      userId: conn.snaptrade_user_id,
      userSecret: conn.snaptrade_user_secret,
    };

    // 1. List all connected accounts
    const accounts = await snapTradeGet('/accounts', clientId, consumerKey, queryParams);

    if (!Array.isArray(accounts) || accounts.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No brokerage accounts found. Please connect a broker first.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Fetch positions from all accounts in parallel
    const allPositions: NormalizedPosition[] = [];

    const positionsPromises = accounts.map(async (acct: { id: string }) => {
      try {
        const positions = await snapTradeGet(
          `/accounts/${acct.id}/positions`,
          clientId,
          consumerKey,
          queryParams
        );
        return Array.isArray(positions) ? positions : [];
      } catch (err) {
        console.warn(`Failed to fetch positions for account ${acct.id}:`, err);
        return [];
      }
    });

    const positionsByAccount = await Promise.all(positionsPromises);

    // 3. Normalize positions
    for (const positions of positionsByAccount) {
      for (const pos of positions) {
        // SnapTrade position structure varies; extract what we can
        const symbol = pos?.symbol?.symbol ?? pos?.symbol?.id ?? pos?.ticker;
        if (!symbol || typeof symbol !== 'string') continue;

        const ticker = symbol.toUpperCase().replace(/\..+$/, ''); // Remove exchange suffix
        if (!ticker || ticker.length > 10) continue; // Skip weird symbols

        const shares = Number(pos?.units ?? pos?.quantity ?? 0);
        if (shares <= 0) continue; // Skip zero/negative positions

        const avgCost = pos?.average_purchase_price != null
          ? Number(pos.average_purchase_price)
          : null;

        const name = pos?.symbol?.description ?? pos?.symbol?.name ?? ticker;

        // Merge if same ticker across accounts (sum shares, weighted avg cost)
        const existing = allPositions.find(p => p.ticker === ticker);
        if (existing) {
          const totalShares = existing.shares + shares;
          if (existing.avgCost != null && avgCost != null) {
            existing.avgCost =
              (existing.avgCost * existing.shares + avgCost * shares) / totalShares;
          }
          existing.shares = totalShares;
        } else {
          allPositions.push({ ticker, name, shares, avgCost });
        }
      }
    }

    // 4. Upsert into portfolios table
    let added = 0;
    let updated = 0;

    // Get existing portfolio
    const { data: existingRows } = await sb
      .from('portfolios')
      .select('ticker')
      .eq('user_id', user.id);
    const existingTickers = new Set((existingRows ?? []).map((r: { ticker: string }) => r.ticker));

    for (const pos of allPositions) {
      if (existingTickers.has(pos.ticker)) {
        // Update shares + avg_cost (broker is source of truth for position data)
        await sb
          .from('portfolios')
          .update({
            shares: pos.shares,
            avg_cost: pos.avgCost,
            name: pos.name,
          })
          .eq('user_id', user.id)
          .eq('ticker', pos.ticker);
        updated++;
      } else {
        // Insert new
        await sb.from('portfolios').insert({
          user_id: user.id,
          ticker: pos.ticker,
          name: pos.name,
          shares: pos.shares,
          avg_cost: pos.avgCost,
        });
        added++;
      }
    }

    // 5. Update last_synced_at
    await sb
      .from('broker_connections')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('user_id', user.id);

    return new Response(
      JSON.stringify({
        positions: allPositions,
        stats: { added, updated, total: allPositions.length },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('broker-sync error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
