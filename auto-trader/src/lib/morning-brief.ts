/**
 * Morning brief generator — runs at 8:00 AM ET on weekdays.
 *
 * Data sources (all free-tier):
 *   1. Finnhub /news?category=general      — last 12 hours of market news
 *   2. Finnhub /calendar/earnings           — today's earnings reporters
 *   3. Finnhub /calendar/economic           — today's economic releases
 *
 * Sends raw data to the generate-morning-brief edge function which uses
 * Llama 70B (via Groq) to synthesize a structured JSON briefing, then
 * upserts it to morning_briefs table.
 */

import { getSupabase } from './supabase.js';

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

function log(msg: string) {
  console.log(`[Morning Brief] ${msg}`);
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

function hoursAgoUnix(hours: number): number {
  return Math.floor((Date.now() - hours * 3_600_000) / 1000);
}

// ── Finnhub Fetchers ──────────────────────────────────────

async function fetchMarketNews() {
  try {
    const from = hoursAgoUnix(14); // slightly wider window to catch overnight
    const url = `https://finnhub.io/api/v1/news?category=general&minId=${from}&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub news ${res.status}`);
    const data = await res.json() as Array<{
      headline: string; summary: string; related: string; datetime: number; source: string;
    }>;
    // Keep last 12h, deduplicate by headline
    const cutoff = hoursAgoUnix(12);
    const seen = new Set<string>();
    return data
      .filter(n => n.datetime >= cutoff)
      .filter(n => { if (seen.has(n.headline)) return false; seen.add(n.headline); return true; })
      .slice(0, 60);
  } catch (err) {
    log(`News fetch failed: ${err}`);
    return [];
  }
}

async function fetchEarningsToday(dateStr: string) {
  try {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${dateStr}&to=${dateStr}&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub earnings ${res.status}`);
    const data = await res.json() as { earningsCalendar?: Array<{
      symbol: string; date: string; epsEstimate?: number; hour?: string;
    }> };
    return (data.earningsCalendar ?? []).slice(0, 30);
  } catch (err) {
    log(`Earnings fetch failed: ${err}`);
    return [];
  }
}

async function fetchEconomicEventsToday(dateStr: string) {
  try {
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${dateStr}&to=${dateStr}&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub econ ${res.status}`);
    const data = await res.json() as { economicCalendar?: Array<{
      event: string; time: string; prior?: string; estimate?: string; impact?: string;
    }> };
    return (data.economicCalendar ?? []).map(e => ({
      event: e.event,
      time: e.time,
      prior: e.prior ?? null,
      estimate: e.estimate ?? null,
      importance: e.impact === 'high' ? 'high' : e.impact === 'medium' ? 'medium' : 'low',
    })).slice(0, 20);
  } catch (err) {
    log(`Economic calendar fetch failed: ${err}`);
    return [];
  }
}

// ── Check if already generated today ─────────────────────

async function alreadyGeneratedToday(dateStr: string): Promise<boolean> {
  const sb = getSupabase();
  const { data } = await sb
    .from('morning_briefs')
    .select('id')
    .eq('brief_date', dateStr)
    .maybeSingle();
  return !!data;
}

// ── Main Entry Point ──────────────────────────────────────

export async function generateMorningBrief(): Promise<void> {
  const dateStr = todayET();
  log(`Generating brief for ${dateStr}...`);

  // Skip if already done today (re-run safe)
  if (await alreadyGeneratedToday(dateStr)) {
    log(`Brief for ${dateStr} already exists — skipping`);
    return;
  }

  // Fetch all data sources in parallel
  const [news, earnings, economicEvents] = await Promise.all([
    fetchMarketNews(),
    fetchEarningsToday(dateStr),
    fetchEconomicEventsToday(dateStr),
  ]);

  log(`Data collected — ${news.length} news items, ${earnings.length} earnings, ${economicEvents.length} econ events`);

  if (news.length === 0 && earnings.length === 0) {
    log('No data to synthesize — skipping (market may be closed)');
    return;
  }

  // Call edge function for AI synthesis
  const edgeFnUrl = `${SUPABASE_URL}/functions/v1/generate-morning-brief`;
  const res = await fetch(edgeFnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ brief_date: dateStr, news, earnings, economic_events: economicEvents }),
  });

  if (!res.ok) {
    const errText = await res.text();
    log(`Edge function error ${res.status}: ${errText}`);
    return;
  }

  const result = await res.json() as { ok: boolean; brief_date: string };
  if (result.ok) {
    log(`✅ Morning brief for ${result.brief_date} generated and saved`);
  } else {
    log(`❌ Edge function returned error: ${JSON.stringify(result)}`);
  }
}
