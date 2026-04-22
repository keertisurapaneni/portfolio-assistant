// send-alert-email — sends transactional email via Resend and logs to alert_log
// Called by the auto-trader scheduler for critical failure events.
//
// POST body: { alert_type, ticker?, subject, body, email_to }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
  const FROM_EMAIL = 'Portfolio Engine <alerts@resend.dev>';

  try {
    const { alert_type, ticker, subject, body, email_to } = await req.json() as {
      alert_type: string;
      ticker?: string;
      subject: string;
      body: string;
      email_to: string;
    };

    if (!email_to || !subject || !body) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing required fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Check for duplicate alert within cooldown window (prevents spam)
    const cooldownMinutes = alert_type === 'deadmans_switch' ? 240 : 60;
    const cooldownSince = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const { data: recentAlerts } = await supabase
      .from('alert_log')
      .select('id')
      .eq('alert_type', alert_type)
      .eq('ticker', ticker ?? '')
      .gte('sent_at', cooldownSince)
      .limit(1);

    if (recentAlerts && recentAlerts.length > 0) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'cooldown_active' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Send via Resend
    let emailSent = false;
    if (RESEND_API_KEY) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [email_to],
          subject,
          html: `<pre style="font-family:monospace;font-size:14px;line-height:1.6">${body}</pre>`,
        }),
      });
      emailSent = emailRes.ok;
      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error('[send-alert-email] Resend error:', errText);
      }
    } else {
      // No API key — log to console only (dev mode)
      console.warn('[send-alert-email] No RESEND_API_KEY — logging alert to console only');
      console.log(`ALERT [${alert_type}] to ${email_to}:\n${subject}\n\n${body}`);
      emailSent = true; // treat as sent for logging purposes
    }

    // Log to alert_log regardless
    await supabase.from('alert_log').insert({
      alert_type,
      ticker: ticker ?? null,
      subject,
      body,
      email_to,
    });

    return new Response(JSON.stringify({ ok: true, sent: emailSent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[send-alert-email]:', err);
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Unknown' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
