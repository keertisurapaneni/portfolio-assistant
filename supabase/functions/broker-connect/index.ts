/**
 * broker-connect — SnapTrade user registration, portal URL generation, and disconnect.
 *
 * Actions:
 *   register  — Register new SnapTrade user + generate connection portal URL
 *   portal    — Generate portal URL for existing user (add another broker)
 *   disconnect — Delete SnapTrade user + remove broker_connections row
 *   status    — Check if user has a broker connection
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

async function getSnapTradeHeaders(
  clientId: string,
  consumerKey: string,
  path: string,
  body?: string
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const content = body ?? '';
  const sigData = `/api/v1${path}&${timestamp}&${content}`;
  const signature = await hmacSha256Base64(consumerKey, sigData);

  return {
    'Content-Type': 'application/json',
    clientId,
    timestamp,
    Signature: signature,
  };
}

async function snapTradeRequest(
  method: string,
  path: string,
  clientId: string,
  consumerKey: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>
) {
  let url = `${SNAPTRADE_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += `?${params}`;
  }

  const bodyStr = body ? JSON.stringify(body) : undefined;
  const headers = await getSnapTradeHeaders(clientId, consumerKey, path, bodyStr);

  const res = await fetch(url, { method, headers, body: bodyStr });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.detail ?? data?.message ?? `SnapTrade ${res.status}`);
  }
  return data;
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

    const { action } = await req.json();

    // ── STATUS ──
    if (action === 'status') {
      const { data: conn } = await sb
        .from('broker_connections')
        .select('snaptrade_user_id, last_synced_at, created_at')
        .eq('user_id', user.id)
        .single();

      return new Response(
        JSON.stringify({ connected: !!conn, lastSyncedAt: conn?.last_synced_at, createdAt: conn?.created_at }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── REGISTER (first time) ──
    if (action === 'register') {
      // Check if already registered
      const { data: existing } = await sb
        .from('broker_connections')
        .select('snaptrade_user_id, snaptrade_user_secret')
        .eq('user_id', user.id)
        .single();

      let snapUserId: string;
      let snapUserSecret: string;

      if (existing) {
        snapUserId = existing.snaptrade_user_id;
        snapUserSecret = existing.snaptrade_user_secret;
      } else {
        // Register new SnapTrade user
        const regResult = await snapTradeRequest(
          'POST',
          '/snapTrade/registerUser',
          clientId,
          consumerKey,
          { userId: user.id }
        );
        snapUserId = regResult.userId;
        snapUserSecret = regResult.userSecret;

        // Store in DB
        await sb.from('broker_connections').insert({
          user_id: user.id,
          snaptrade_user_id: snapUserId,
          snaptrade_user_secret: snapUserSecret,
        });
      }

      // Generate connection portal URL
      const loginResult = await snapTradeRequest(
        'POST',
        '/snapTrade/login',
        clientId,
        consumerKey,
        {
          userId: snapUserId,
          userSecret: snapUserSecret,
          connectionType: 'read',
          immediateRedirect: true,
        }
      );

      return new Response(
        JSON.stringify({ redirectUrl: loginResult.redirectURI ?? loginResult.loginLink }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── PORTAL (existing user, add another broker) ──
    if (action === 'portal') {
      const { data: conn } = await sb
        .from('broker_connections')
        .select('snaptrade_user_id, snaptrade_user_secret')
        .eq('user_id', user.id)
        .single();

      if (!conn) {
        return new Response(JSON.stringify({ error: 'No broker connection found. Register first.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const loginResult = await snapTradeRequest(
        'POST',
        '/snapTrade/login',
        clientId,
        consumerKey,
        {
          userId: conn.snaptrade_user_id,
          userSecret: conn.snaptrade_user_secret,
          connectionType: 'read',
          immediateRedirect: true,
        }
      );

      return new Response(
        JSON.stringify({ redirectUrl: loginResult.redirectURI ?? loginResult.loginLink }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── DISCONNECT ──
    if (action === 'disconnect') {
      const { data: conn } = await sb
        .from('broker_connections')
        .select('snaptrade_user_id, snaptrade_user_secret')
        .eq('user_id', user.id)
        .single();

      if (conn) {
        // Delete SnapTrade user (this removes all their connections)
        try {
          await snapTradeRequest(
            'DELETE',
            `/snapTrade/deleteUser`,
            clientId,
            consumerKey,
            undefined,
            { userId: conn.snaptrade_user_id, userSecret: conn.snaptrade_user_secret }
          );
        } catch (err) {
          console.warn('SnapTrade deleteUser failed (may already be deleted):', err);
        }

        // Remove from our DB
        await sb.from('broker_connections').delete().eq('user_id', user.id);
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('broker-connect error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
