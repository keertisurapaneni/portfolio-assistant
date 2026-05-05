/**
 * Economic Event Calendar Gate
 *
 * SMB Capital insight: ~25% of trading days have high-impact economic events
 * (FOMC, CPI, NFP, PCE, GDP) that cause outsized market volatility. These days
 * wreck premium-selling and directional day trades alike.
 *
 * This module fetches today's economic calendar from Finnhub at market open and
 * determines whether any high-impact events are scheduled. The scheduler can
 * then halve day-trade position sizes on those days to reduce risk.
 */

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';

// Events that historically cause outsized intraday volatility.
// Matched case-insensitively against the Finnhub event description.
const HIGH_IMPACT_KEYWORDS = [
  'fomc',
  'federal funds rate',
  'interest rate decision',
  'nonfarm payroll', 'non-farm payroll', 'nfp',
  'consumer price index', 'cpi',
  'producer price index', 'ppi',
  'gross domestic product', 'gdp',
  'pce price index', 'pce',
  'unemployment rate',
  'retail sales',
  'ism manufacturing',
  'ism services',
  'fed chair', 'powell',
];

export interface EconDayProfile {
  isHighImpact: boolean;
  events: Array<{ event: string; time: string; impact: string }>;
  positionSizeMultiplier: number;  // 1.0 = normal, 0.5 = halved
}

let _cachedProfile: EconDayProfile | null = null;
let _cachedDate: string | null = null;

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Fetch today's economic calendar and classify the day.
 * Cached per trading day — only one Finnhub call per session.
 */
export async function getEconDayProfile(): Promise<EconDayProfile> {
  const dateStr = todayET();
  if (_cachedProfile && _cachedDate === dateStr) return _cachedProfile;

  const defaultProfile: EconDayProfile = {
    isHighImpact: false, events: [], positionSizeMultiplier: 1.0,
  };

  if (!FINNHUB_KEY) {
    _cachedProfile = defaultProfile;
    _cachedDate = dateStr;
    return defaultProfile;
  }

  try {
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${dateStr}&to=${dateStr}&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub econ calendar ${res.status}`);

    const data = await res.json() as {
      economicCalendar?: Array<{ event: string; time: string; impact?: string }>;
    };

    const events = (data.economicCalendar ?? []).map(e => ({
      event: e.event,
      time: e.time,
      impact: e.impact ?? 'low',
    }));

    const highImpactEvents = events.filter(e => {
      if (e.impact === 'high') return true;
      const lower = e.event.toLowerCase();
      return HIGH_IMPACT_KEYWORDS.some(kw => lower.includes(kw));
    });

    const isHighImpact = highImpactEvents.length > 0;

    const profile: EconDayProfile = {
      isHighImpact,
      events: highImpactEvents.length > 0 ? highImpactEvents : events.slice(0, 5),
      positionSizeMultiplier: isHighImpact ? 0.5 : 1.0,
    };

    _cachedProfile = profile;
    _cachedDate = dateStr;
    return profile;
  } catch (err) {
    console.warn(`[EconCalendar] Fetch failed: ${err instanceof Error ? err.message : err}`);
    _cachedProfile = defaultProfile;
    _cachedDate = dateStr;
    return defaultProfile;
  }
}
