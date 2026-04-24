/**
 * Generate a structured pre-market trading briefing from raw market data.
 *
 * Can be called two ways:
 *
 * 1. Self-sufficient (from UI "Generate Now" or pg_cron directly):
 *    POST {} — edge function fetches Finnhub data itself using FINNHUB_API_KEY secret.
 *
 * 2. Pre-fetched (from auto-trader morning-brief.ts):
 *    POST { brief_date, news, earnings, economic_events } — uses provided data directly.
 *
 * Output: upserts to morning_briefs table and returns the structured brief.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const BRIEF_SYSTEM = `You are a professional pre-market trading analyst. You synthesize raw market data into a concise, actionable daily briefing for a retail options and equity trader.

Return ONLY a single JSON object (no markdown, no code blocks) with these exact fields:

{
  "macro_snapshot": "2-3 sentence market setup for today. Cover: Fed stance, dominant market theme, overall risk tone (risk-on/off). Be specific and direct.",
  "macro_tone": "1-2 paragraph expanded macro context. What's driving markets? Any geopolitical developments, commodity moves, or sentiment shifts?",
  "economic_events": [
    { "time_et": "8:30 AM", "event": "CPI MoM", "prior": "0.4%", "estimate": "0.3%", "importance": "high" }
  ],
  "earnings": [
    { "ticker": "TSLA", "when": "before_open", "note": "Expected EPS $0.52. Watch guidance on energy business.", "direction": "neutral" }
  ],
  "top_movers": [
    { "ticker": "NVDA", "direction": "bullish", "catalyst": "Earnings beat + raised guidance", "why": "Revenue up 78% YoY driven by data center demand. Options market pricing 8% move." }
  ],
  "research_themes": [
    { "theme": "AI Infrastructure", "tickers": ["NVDA", "AMD", "SMCI"], "note": "Hyperscaler capex guidance being raised across the board." }
  ],
  "secondary_names": [
    { "ticker": "WMT", "direction": "bullish", "note": "Tariff exemption granted on consumer electronics imports." }
  ],
  "week_ahead": "Key events this week: Tuesday Fed speakers (Williams 2pm), Wednesday FOMC minutes, Thursday jobless claims + PPI, Friday options expiration (quad witching)."
}

Rules:
- top_movers: max 5 names, ranked by likely intraday volatility
- secondary_names: additional tickers from news, brief note only
- economic_events: today's releases only, sorted by time
- earnings: pre-market AND after-close reporters for today
- direction: "bullish" | "bearish" | "neutral" | "volatile"
- importance: "high" | "medium" | "low"
- If no data for a section, use empty array [] or empty string ""
- Be specific, concise, and trader-focused — avoid generic statements`;

// ── Finnhub helpers ──────────────────────────────────────────────────────────

async function fetchFinnhub<T>(path: string, finnhubKey: string): Promise<T | null> {
  try {
    const res = await fetch(`https://finnhub.io/api/v1${path}&token=${finnhubKey}`);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

function todayEt(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({})) as {
      brief_date?: string;
      news?: Array<{ headline: string; summary: string; related: string; datetime: number; source: string }>;
      earnings?: Array<{ symbol: string; date: string; epsEstimate?: number; hour?: string }>;
      economic_events?: Array<{ event: string; time: string; prior?: string; estimate?: string; importance?: string }>;
    };

    const brief_date = body.brief_date ?? todayEt();
    const finnhubKey = Deno.env.get('FINNHUB_API_KEY') ?? '';

    // ── Fetch Finnhub data if not pre-provided ───────────────────────────────
    let news = body.news;
    let earnings = body.earnings;
    let economic_events = body.economic_events;

    if (!news) {
      const twelveHoursAgo = Math.floor(Date.now() / 1000) - 12 * 3600;
      const raw = await fetchFinnhub<{ id: number; headline: string; summary: string; related: string; datetime: number; source: string }[]>(
        `/news?category=general&minId=${twelveHoursAgo}`, finnhubKey
      );
      news = raw ?? [];
    }

    if (!earnings) {
      const raw = await fetchFinnhub<{ earningsCalendar: Array<{ symbol: string; date: string; epsEstimate?: number; hour?: string }> }>(
        `/calendar/earnings?from=${brief_date}&to=${brief_date}`, finnhubKey
      );
      earnings = raw?.earningsCalendar ?? [];
    }

    if (!economic_events) {
      const raw = await fetchFinnhub<{ economicCalendar: Array<{ event: string; time: string; prior?: string; estimate?: string; importance?: string }> }>(
        `/calendar/economic?from=${brief_date}&to=${brief_date}`, finnhubKey
      );
      economic_events = raw?.economicCalendar ?? [];
    }

    // ── Build prompt ─────────────────────────────────────────────────────────
    const newsSummary = news.slice(0, 40).map(n =>
      `[${n.related || 'MACRO'}] ${n.headline}${n.summary ? ': ' + n.summary.slice(0, 200) : ''}`
    ).join('\n');

    const earningsSummary = earnings.map(e =>
      `${e.symbol} — ${e.hour === 'bmo' ? 'Before Open' : e.hour === 'amc' ? 'After Close' : 'TBD'}${e.epsEstimate ? `, EPS est: $${e.epsEstimate}` : ''}`
    ).join('\n');

    const econSummary = economic_events.map(e =>
      `${e.time} ET — ${e.event}${e.estimate ? ` (est: ${e.estimate}` : ''}${e.prior ? `, prior: ${e.prior})` : e.estimate ? ')' : ''}`
    ).join('\n');

    const userPrompt = `Date: ${brief_date}

=== MARKET NEWS (last 12 hours) ===
${newsSummary || 'No news items available.'}

=== EARNINGS TODAY ===
${earningsSummary || 'No earnings reporters today.'}

=== ECONOMIC CALENDAR TODAY ===
${econSummary || 'No major economic releases scheduled.'}

Generate the structured daily market briefing JSON for this trading day.`;

    // ── Call Groq / Llama ────────────────────────────────────────────────────
    const groqKey = Deno.env.get('GROQ_API_KEY') ?? '';
    if (!groqKey) throw new Error('GROQ_API_KEY secret not set in Supabase Edge Function secrets');

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: BRIEF_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!groqRes.ok) throw new Error(`Groq error: ${groqRes.status} ${await groqRes.text()}`);
    const groqData = await groqRes.json() as { choices: [{ message: { content: string } }] };
    const raw = groqData.choices[0].message.content.trim();

    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const brief = JSON.parse(jsonStr) as {
      macro_snapshot: string; macro_tone: string;
      economic_events: unknown[]; earnings: unknown[];
      top_movers: unknown[]; research_themes: unknown[];
      secondary_names: unknown[]; week_ahead: string;
    };

    // ── Upsert to DB ─────────────────────────────────────────────────────────
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error: upsertErr } = await sb.from('morning_briefs').upsert({
      brief_date,
      macro_snapshot:   brief.macro_snapshot ?? '',
      macro_tone:       brief.macro_tone ?? '',
      economic_events:  brief.economic_events ?? [],
      earnings:         brief.earnings ?? [],
      top_movers:       brief.top_movers ?? [],
      research_themes:  brief.research_themes ?? [],
      secondary_names:  brief.secondary_names ?? [],
      week_ahead:       brief.week_ahead ?? '',
      raw_news_count:   news.length,
      generated_at:     new Date().toISOString(),
    }, { onConflict: 'brief_date' });

    if (upsertErr) throw new Error(`DB upsert failed: ${upsertErr.message}`);

    return new Response(JSON.stringify({ ok: true, brief_date, brief }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[generate-morning-brief]', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
