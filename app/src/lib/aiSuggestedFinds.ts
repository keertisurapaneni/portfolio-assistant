/**
 * AI-Powered Stock Discovery — Grounded in Real Data
 *
 * Architecture:
 *   Quiet Compounders: Gemini (candidates) → Finnhub (real metrics) → Gemini (analysis on facts)
 *   Gold Mines:        Finnhub (market news) → Gemini (theme extraction + stock mapping)
 *
 * Data Source Rules:
 *   - Compounders: ONLY Finnhub structured data. No news, no inferred macro trends.
 *   - Gold Mines: Recent market news as primary signal. Facts only — no summaries, no hype.
 *
 * Separation: Groq = Portfolio AI Analysis | Gemini = Suggested Finds Discovery
 */

import type { EnhancedSuggestedStock } from '../data/suggestedFinds';

const GEMINI_PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gemini-proxy`;
const STOCK_DATA_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-stock-data`;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Cache config
const PROMPT_VERSION = 4; // v4: Gold Mines now include real Finnhub metrics
const CACHE_KEY = `gemini-discovery-v${PROMPT_VERSION}`;
const CACHE_DURATION = 1000 * 60 * 60 * 24; // 24 hours

export interface ThemeData {
  name: string;
  description: string;
  categories: { name: string; description: string }[];
}

export interface DiscoveryResult {
  compounders: EnhancedSuggestedStock[];
  goldMines: EnhancedSuggestedStock[];
  currentTheme: ThemeData;
  timestamp: string;
}

export type DiscoveryStep =
  | 'idle'
  | 'finding_candidates'
  | 'fetching_metrics'
  | 'analyzing_compounders'
  | 'fetching_news'
  | 'analyzing_themes'
  | 'done';

interface CachedDiscovery {
  data: DiscoveryResult;
  timestamp: string;
}

// ──────────────────────────────────────────────────────────
// API callers
// ──────────────────────────────────────────────────────────

async function callGemini(
  prompt: string,
  type: 'discover_compounders' | 'discover_goldmines' | 'analyze_themes',
  temperature = 0.4,
  maxOutputTokens = 4000,
  retries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ prompt, type, temperature, maxOutputTokens }),
    });

    if (response.status === 429) {
      const waitSec = attempt * 5;
      console.warn(`[Discovery] 429 (attempt ${attempt}/${retries}), waiting ${waitSec}s...`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ error: 'Unknown' }));
      throw new Error(`Gemini error ${response.status}: ${errData.error || 'Unknown'}`);
    }

    const data = await response.json();
    return data.text ?? '';
  }
  throw new Error('Gemini rate-limited after all retries');
}

async function fetchFinnhub(
  ticker: string,
  endpoint: 'metrics' | 'quote' | 'general_news'
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(STOCK_DATA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
      body: JSON.stringify({ ticker, endpoint }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// Step 1a: Gemini suggests compounder candidates (tickers only)
// ──────────────────────────────────────────────────────────

function buildCandidatePrompt(excludeTickers: string[]): string {
  const exclude = excludeTickers.length > 0
    ? `\nEXCLUDE these tickers (user already owns them): ${excludeTickers.join(', ')}`
    : '';

  return `You are a stock screener. Identify 10 US-listed tickers that could be "Quiet Compounders."

Criteria for candidates:
- Boring, unglamorous industries: logistics, waste, utilities, insurance, distribution, industrial services, food distribution, HVAC, pest control, water treatment
- Known for consistent profitability and stable operations
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks
${exclude}

Return ONLY a JSON array of 10 ticker symbols. No explanations, no other text.
Example: ["ODFL", "POOL", "WSO", "TJX"]`;
}

// ──────────────────────────────────────────────────────────
// Step 1b: Fetch Finnhub metrics for candidates
// ──────────────────────────────────────────────────────────

interface FinnhubMetricData {
  ticker: string;
  roe: number | null;
  profitMargin: number | null;
  operatingMargin: number | null;
  eps: number | null;
  pe: number | null;
  beta: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  marketCap: number | null;
  grossMargin: number | null;
}

async function fetchMetricsForTickers(tickers: string[]): Promise<FinnhubMetricData[]> {
  const results: FinnhubMetricData[] = [];

  // Fetch in batches of 5 with small delays to respect Finnhub rate limits
  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const batchResults = await Promise.all(
      batch.map(async (ticker) => {
        const data = await fetchFinnhub(ticker, 'metrics');
        if (!data) return null;

        const m = (data as { metric?: Record<string, number> }).metric || {};
        return {
          ticker,
          roe: m.roeTTM ?? m.roeAnnual ?? null,
          profitMargin: m.netProfitMarginTTM ?? m.netProfitMarginAnnual ?? null,
          operatingMargin: m.operatingMarginTTM ?? m.operatingMarginAnnual ?? null,
          eps: m.epsTTM ?? m.epsAnnual ?? null,
          pe: m.peTTM ?? m.peAnnual ?? null,
          beta: m.beta ?? null,
          revenueGrowth: m.revenueGrowthTTMYoy ?? m.revenueGrowthQuarterlyYoy ?? null,
          epsGrowth: m.epsGrowthTTMYoy ?? m.epsGrowthQuarterlyYoy ?? null,
          marketCap: m.marketCapitalization ?? null,
          grossMargin: m.grossMarginTTM ?? m.grossMarginAnnual ?? null,
        } as FinnhubMetricData;
      })
    );

    results.push(...batchResults.filter((r): r is FinnhubMetricData => r !== null));

    // Small delay between batches
    if (i + 5 < tickers.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return results;
}

// ──────────────────────────────────────────────────────────
// Step 2a: Gemini analyzes compounders with REAL Finnhub data
// ──────────────────────────────────────────────────────────

function buildCompounderAnalysisPrompt(metrics: FinnhubMetricData[]): string {
  const stockDataBlock = metrics
    .map((m) => {
      const lines = [`Ticker: ${m.ticker}`];
      if (m.roe !== null) lines.push(`  ROE: ${m.roe.toFixed(1)}%`);
      if (m.profitMargin !== null) lines.push(`  Profit Margin: ${m.profitMargin.toFixed(1)}%`);
      if (m.operatingMargin !== null) lines.push(`  Operating Margin: ${m.operatingMargin.toFixed(1)}%`);
      if (m.grossMargin !== null) lines.push(`  Gross Margin: ${m.grossMargin.toFixed(1)}%`);
      if (m.eps !== null) lines.push(`  EPS (TTM): $${m.eps.toFixed(2)}`);
      if (m.pe !== null) lines.push(`  P/E: ${m.pe.toFixed(1)}`);
      if (m.beta !== null) lines.push(`  Beta: ${m.beta.toFixed(2)}`);
      if (m.revenueGrowth !== null) lines.push(`  Revenue Growth YoY: ${m.revenueGrowth.toFixed(1)}%`);
      if (m.epsGrowth !== null) lines.push(`  EPS Growth YoY: ${m.epsGrowth.toFixed(1)}%`);
      if (m.marketCap !== null) lines.push(`  Market Cap: $${(m.marketCap / 1000).toFixed(1)}B`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `You are a disciplined stock analyst. Analyze ONLY the Finnhub data provided below.

RULES:
- Use ONLY the metrics given for analysis. Do not infer, estimate, or fabricate any metrics.
- You MAY fill in company names from your knowledge (e.g., FAST = Fastenal, WM = Waste Management).
- Do not reference news, macro trends, or market sentiment.
- Be concise and factual. No narratives, hype, or storytelling.
- If a metric is missing, note it — do not guess.

QUALIFYING CRITERIA for Quiet Compounders:
- ROE > 12% (proxy for ROIC durability)
- Positive profit margins (net or operating)
- Beta < 1.3 (low volatility, stable business)
- Positive EPS (profitable)
- Consistent revenue or EPS growth is a plus

FINNHUB DATA:
${stockDataBlock}

TASK: Select the 6 strongest Quiet Compounders from the data above. For each, explain WHY using only the numbers provided.

Return ONLY valid JSON:
{
  "stocks": [
    {
      "ticker": "SYM",
      "name": "Company Name",
      "tag": "Quiet Compounder",
      "reason": "One factual sentence citing specific metrics from the data above",
      "whyGreat": [
        "Specific metric-backed point (e.g. 'ROE of 22% indicates durable capital efficiency')",
        "Second metric-backed point",
        "Third metric-backed point"
      ],
      "metrics": [
        { "label": "ROE", "value": "22%" },
        { "label": "Profit Margin", "value": "15%" },
        { "label": "Beta", "value": "0.85" }
      ]
    }
  ]
}

Return exactly 6 stocks. Each must have 3 whyGreat points and 3 metrics — all sourced from the data above. Do NOT fabricate numbers.`;
}

// ──────────────────────────────────────────────────────────
// Step 1c: Fetch general market news for Gold Mines
// ──────────────────────────────────────────────────────────

interface MarketNewsItem {
  headline: string;
  source: string;
  datetime: number;
  summary?: string;
}

async function fetchGeneralMarketNews(): Promise<MarketNewsItem[]> {
  const data = await fetchFinnhub('_MARKET', 'general_news');
  if (!data || !Array.isArray(data)) {
    // Handle case where data is wrapped in an object
    const items = data ? Object.values(data) : [];
    if (!Array.isArray(items) || items.length === 0) return [];

    return items
      .filter((item: unknown) => {
        const n = item as Record<string, unknown>;
        return typeof n.headline === 'string' && n.headline.length > 0;
      })
      .slice(0, 30) // Last 30 headlines
      .map((item: unknown) => {
        const n = item as Record<string, unknown>;
        return {
          headline: String(n.headline || ''),
          source: String(n.source || ''),
          datetime: Number(n.datetime || 0),
          summary: n.summary ? String(n.summary) : undefined,
        };
      });
  }

  return (data as Array<Record<string, unknown>>)
    .filter((n) => typeof n.headline === 'string' && (n.headline as string).length > 0)
    .slice(0, 30)
    .map((n) => ({
      headline: String(n.headline || ''),
      source: String(n.source || ''),
      datetime: Number(n.datetime || 0),
      summary: n.summary ? String(n.summary) : undefined,
    }));
}

// ──────────────────────────────────────────────────────────
// Step 2b: Gemini extracts themes + stocks from real news
// ──────────────────────────────────────────────────────────

// Step A: Gemini extracts tickers + theme from headlines (lightweight — tickers only)
function buildGoldMineCandidatePrompt(news: MarketNewsItem[], excludeTickers: string[]): string {
  const exclude = excludeTickers.length > 0
    ? `\nEXCLUDE these tickers (user already owns them): ${excludeTickers.join(', ')}`
    : '';

  const newsBlock = news
    .map((n, i) => {
      const date = new Date(n.datetime * 1000).toISOString().split('T')[0];
      return `${i + 1}. [${date}] ${n.headline} (${n.source})`;
    })
    .join('\n');

  return `You are a disciplined macro analyst. Below are real market headlines.

STRICT RULES:
1. ONLY pick stocks that are DIRECTLY mentioned by name or ticker in the headlines.
2. Do NOT pick stocks based on vague sector association. "Tech rebounds" does NOT justify random tech stocks.
3. Do NOT spin bearish headlines into buy theses.
4. NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA.
5. Quality over quantity — if fewer than 4 stocks are directly mentioned, return fewer.
${exclude}

HEADLINES:
${newsBlock}

TASK:
1. Identify companies EXPLICITLY mentioned by name in the headlines.
2. Identify the dominant investable theme.
3. Return 4-6 tickers and the theme.

Return ONLY valid JSON:
{
  "theme": {
    "name": "Theme Name",
    "description": "1-2 sentences citing specific headline facts",
    "categories": [
      { "name": "Category", "description": "Brief description" }
    ]
  },
  "tickers": [
    { "ticker": "SYM", "name": "Company Name", "category": "Category", "headline_ref": "Which headline # mentions them" }
  ]
}`;
}

// Step B: Gemini analyzes Gold Mine picks with REAL Finnhub data + headline context (same format as Compounders)
function buildGoldMineAnalysisPrompt(
  metrics: FinnhubMetricData[],
  news: MarketNewsItem[],
  candidates: Array<{ ticker: string; name: string; category: string; headline_ref: string }>,
  theme: ThemeData
): string {
  // Build Finnhub data block — same format as Compounders
  const stockDataBlock = metrics
    .map((m) => {
      const candidate = candidates.find((c) => c.ticker === m.ticker);
      const lines = [`Ticker: ${m.ticker} (${candidate?.name || m.ticker})`];
      lines.push(`  Headline context: ${candidate?.headline_ref || 'N/A'}`);
      lines.push(`  Category: ${candidate?.category || 'N/A'}`);
      if (m.roe !== null) lines.push(`  ROE: ${m.roe.toFixed(1)}%`);
      if (m.profitMargin !== null) lines.push(`  Profit Margin: ${m.profitMargin.toFixed(1)}%`);
      if (m.operatingMargin !== null) lines.push(`  Operating Margin: ${m.operatingMargin.toFixed(1)}%`);
      if (m.grossMargin !== null) lines.push(`  Gross Margin: ${m.grossMargin.toFixed(1)}%`);
      if (m.eps !== null) lines.push(`  EPS (TTM): $${m.eps.toFixed(2)}`);
      if (m.pe !== null) lines.push(`  P/E: ${m.pe.toFixed(1)}`);
      if (m.beta !== null) lines.push(`  Beta: ${m.beta.toFixed(2)}`);
      if (m.revenueGrowth !== null) lines.push(`  Revenue Growth YoY: ${m.revenueGrowth.toFixed(1)}%`);
      if (m.epsGrowth !== null) lines.push(`  EPS Growth YoY: ${m.epsGrowth.toFixed(1)}%`);
      if (m.marketCap !== null) lines.push(`  Market Cap: $${(m.marketCap / 1000).toFixed(1)}B`);
      return lines.join('\n');
    })
    .join('\n\n');

  // Build headlines summary for context
  const headlinesSummary = news
    .slice(0, 15)
    .map((n, i) => {
      const date = new Date(n.datetime * 1000).toISOString().split('T')[0];
      return `${i + 1}. [${date}] ${n.headline}`;
    })
    .join('\n');

  return `You are a disciplined stock analyst. Analyze the Finnhub data below for stocks identified from recent market headlines.

Theme: "${theme.name}" — ${theme.description}

RULES:
- Use ONLY the Finnhub metrics given for financial analysis. Do not fabricate numbers.
- You MAY fill in company names from your knowledge.
- For "reason" and "whyGreat": combine the headline catalyst WITH the financial data.
- Each whyGreat point should cite a specific metric from the data.
- Be concise and factual. No hype.

RECENT HEADLINES (for context):
${headlinesSummary}

FINNHUB DATA:
${stockDataBlock}

TASK: Analyze each stock. For each, explain WHY it's interesting using BOTH the headline catalyst AND the real financial metrics.

Return ONLY valid JSON:
{
  "stocks": [
    {
      "ticker": "SYM",
      "name": "Company Name",
      "tag": "Gold Mine",
      "reason": "One sentence combining the headline catalyst with a key financial metric",
      "category": "Value chain category",
      "whyGreat": [
        "Specific metric-backed point (e.g. 'ROE of 22% shows strong capital efficiency')",
        "Second metric-backed point tied to the headline catalyst",
        "Third factual point citing data"
      ],
      "metrics": [
        { "label": "ROE", "value": "22%" },
        { "label": "Profit Margin", "value": "15%" },
        { "label": "Beta", "value": "0.85" }
      ]
    }
  ]
}

Analyze all stocks provided. Each must have 3 whyGreat points and 3 metrics — all from the Finnhub data above.`;
}

// ──────────────────────────────────────────────────────────
// Response parsers
// ──────────────────────────────────────────────────────────

function cleanJSON(raw: string): string {
  return raw
    .replace(/```json?\s*/g, '')
    .replace(/```/g, '')
    .trim();
}

function parseCompounderResponse(raw: string): EnhancedSuggestedStock[] {
  const parsed = JSON.parse(cleanJSON(raw));
  const stocks = parsed.stocks || parsed;
  if (!Array.isArray(stocks)) throw new Error('Expected stocks array');

  return stocks.map((s: Record<string, unknown>) => ({
    ticker: String(s.ticker || '').toUpperCase(),
    name: String(s.name || ''),
    tag: 'Quiet Compounder' as const,
    reason: String(s.reason || ''),
    whyGreat: Array.isArray(s.whyGreat) ? s.whyGreat.map(String) : [],
    metrics: Array.isArray(s.metrics)
      ? (s.metrics as Array<{ label: string; value: string }>).map((m) => ({
          label: String(m.label || ''),
          value: String(m.value || ''),
        }))
      : [],
  }));
}

// Parse step A: Gold Mine candidate tickers + theme
function parseGoldMineCandidates(raw: string): {
  theme: ThemeData;
  candidates: Array<{ ticker: string; name: string; category: string; headline_ref: string }>;
} {
  const parsed = JSON.parse(cleanJSON(raw));

  const theme: ThemeData = {
    name: String(parsed.theme?.name || 'Market Theme'),
    description: String(parsed.theme?.description || ''),
    categories: Array.isArray(parsed.theme?.categories)
      ? parsed.theme.categories.map((c: { name: string; description: string }) => ({
          name: String(c.name || ''),
          description: String(c.description || ''),
        }))
      : [],
  };

  const tickers = parsed.tickers || parsed.stocks || [];
  const candidates = (Array.isArray(tickers) ? tickers : []).map((t: Record<string, unknown>) => ({
    ticker: String(t.ticker || '').toUpperCase(),
    name: String(t.name || ''),
    category: String(t.category || ''),
    headline_ref: String(t.headline_ref || ''),
  }));

  return { theme, candidates };
}

// Parse step B: Gold Mine analyzed stocks (same structure as Compounders)
function parseGoldMineAnalysis(raw: string): EnhancedSuggestedStock[] {
  const parsed = JSON.parse(cleanJSON(raw));
  const stocks = parsed.stocks || parsed;
  if (!Array.isArray(stocks)) throw new Error('Expected stocks array');

  return stocks.map((s: Record<string, unknown>) => ({
    ticker: String(s.ticker || '').toUpperCase(),
    name: String(s.name || ''),
    tag: 'Gold Mine' as const,
    reason: String(s.reason || ''),
    category: String(s.category || ''),
    whyGreat: Array.isArray(s.whyGreat) ? s.whyGreat.map(String) : [],
    metrics: Array.isArray(s.metrics)
      ? (s.metrics as Array<{ label: string; value: string }>).map((m) => ({
          label: String(m.label || ''),
          value: String(m.value || ''),
        }))
      : [],
  }));
}

function parseCandidateTickers(raw: string): string[] {
  console.log('[Discovery] Raw candidate response:', raw.slice(0, 300));
  const cleaned = cleanJSON(raw);

  // Try JSON parse first
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.map((t: string) => String(t).toUpperCase());
    if (parsed.tickers && Array.isArray(parsed.tickers))
      return parsed.tickers.map((t: string) => String(t).toUpperCase());
    if (parsed.stocks && Array.isArray(parsed.stocks))
      return parsed.stocks.map((s: unknown) =>
        typeof s === 'string' ? s.toUpperCase() : String((s as Record<string, unknown>).ticker || '').toUpperCase()
      );
  } catch {
    console.warn('[Discovery] JSON parse failed, trying regex extraction...');
  }

  // Fallback: extract ticker-like symbols with regex (1-5 uppercase letters)
  const matches = cleaned.match(/\b[A-Z]{1,5}\b/g);
  if (matches && matches.length >= 3) {
    // Filter out common English words that look like tickers
    const skipWords = new Set(['THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'HAS', 'WAS', 'ALL', 'CAN', 'HAD', 'HER', 'ONE', 'OUR', 'OUT', 'YOU', 'DAY', 'GET', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'BOY', 'DID', 'USE', 'SAY', 'SHE', 'TWO', 'SET', 'JSON', 'ONLY', 'ALSO', 'WITH', 'FROM', 'JUST', 'LIKE', 'THEM', 'THAN', 'EACH', 'MAKE']);
    const tickers = matches.filter((m) => !skipWords.has(m));
    console.log('[Discovery] Regex-extracted tickers:', tickers.slice(0, 12));
    return tickers.slice(0, 12);
  }

  throw new Error('Could not extract tickers from Gemini response');
}

// ──────────────────────────────────────────────────────────
// Cache management
// ──────────────────────────────────────────────────────────

function getCachedDiscovery(): CachedDiscovery | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedDiscovery = JSON.parse(raw);
    const age = Date.now() - new Date(cached.timestamp).getTime();
    if (age < CACHE_DURATION) return cached;
  } catch { /* invalid cache */ }
  return null;
}

function cacheDiscovery(data: DiscoveryResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: new Date().toISOString() }));
  } catch { /* storage full */ }
}

export function clearDiscoveryCache(): void {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* */ }
}

export function getCachedTimestamp(): string | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw).timestamp;
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────
// Main orchestrator — two-step grounded pipeline
// ──────────────────────────────────────────────────────────

export async function discoverStocks(
  existingTickers: string[],
  forceRefresh = false,
  onStep?: (step: DiscoveryStep) => void
): Promise<DiscoveryResult> {
  // Check cache
  if (!forceRefresh) {
    const cached = getCachedDiscovery();
    if (cached) {
      console.log('[Discovery] Using 24h cached results');
      onStep?.('done');
      return cached.data;
    }
  }

  // ── QUIET COMPOUNDERS PIPELINE ──

  // Step 1: Gemini suggests candidate tickers
  onStep?.('finding_candidates');
  console.log('[Discovery] Step 1: Asking Gemini for compounder candidates...');
  const candidateRaw = await callGemini(
    buildCandidatePrompt(existingTickers),
    'discover_compounders',
    0.5,
    1000 // Enough room for a JSON array of 10 tickers
  );
  console.log('[Discovery] Gemini candidates raw length:', candidateRaw.length);
  const candidateTickers = parseCandidateTickers(candidateRaw);
  console.log(`[Discovery] Candidates: ${candidateTickers.join(', ')}`);

  // Step 2: Fetch real Finnhub metrics for each candidate
  onStep?.('fetching_metrics');
  console.log('[Discovery] Step 2: Fetching Finnhub metrics for candidates...');
  const metricsData = await fetchMetricsForTickers(candidateTickers);
  console.log(`[Discovery] Got metrics for ${metricsData.length}/${candidateTickers.length} tickers`);

  // Filter out tickers with no data
  const validMetrics = metricsData.filter(
    (m) => m.roe !== null || m.profitMargin !== null || m.eps !== null
  );

  // Step 3: Gemini analyzes with real data
  onStep?.('analyzing_compounders');
  console.log('[Discovery] Step 3: Gemini analyzing compounders with real Finnhub data...');

  // 2s pause between Gemini calls for rate limit safety
  await new Promise((r) => setTimeout(r, 2000));

  const compounderRaw = await callGemini(
    buildCompounderAnalysisPrompt(validMetrics),
    'discover_compounders',
    0.3,
    4000
  );
  const compounders = parseCompounderResponse(compounderRaw);

  // ── GOLD MINES PIPELINE (same 3-step pattern as Compounders) ──

  // Step 4: Fetch real market news from Finnhub
  onStep?.('fetching_news');
  console.log('[Discovery] Step 4: Fetching general market news from Finnhub...');
  const marketNews = await fetchGeneralMarketNews();
  console.log(`[Discovery] Got ${marketNews.length} market headlines`);

  // Step 5a: Gemini picks tickers from headlines (lightweight — tickers + theme only)
  onStep?.('analyzing_themes');
  console.log('[Discovery] Step 5a: Gemini identifying stocks from headlines...');

  await new Promise((r) => setTimeout(r, 2000));

  const goldMineCandidateRaw = await callGemini(
    buildGoldMineCandidatePrompt(marketNews, existingTickers),
    'discover_goldmines',
    0.3,
    1500
  );
  const { theme: currentTheme, candidates: goldMineCandidates } = parseGoldMineCandidates(goldMineCandidateRaw);
  console.log(`[Discovery] Theme: "${currentTheme.name}" — ${goldMineCandidates.length} candidates: ${goldMineCandidates.map(c => c.ticker).join(', ')}`);

  // Step 5b: Fetch real Finnhub metrics for Gold Mine picks
  console.log('[Discovery] Step 5b: Fetching Finnhub metrics for Gold Mine picks...');
  const goldMineTickers = goldMineCandidates.map((c) => c.ticker);
  const goldMineMetrics = await fetchMetricsForTickers(goldMineTickers);
  const validGoldMineMetrics = goldMineMetrics.filter(
    (m) => m.roe !== null || m.profitMargin !== null || m.eps !== null
  );
  console.log(`[Discovery] Got metrics for ${validGoldMineMetrics.length}/${goldMineTickers.length} Gold Mine picks`);

  // Step 5c: Gemini analyzes Gold Mines with real Finnhub data + headline context
  console.log('[Discovery] Step 5c: Gemini analyzing Gold Mines with real data + headlines...');

  await new Promise((r) => setTimeout(r, 2000));

  const goldMineAnalysisRaw = await callGemini(
    buildGoldMineAnalysisPrompt(validGoldMineMetrics, marketNews, goldMineCandidates, currentTheme),
    'discover_goldmines',
    0.3,
    4000
  );
  const goldMines = parseGoldMineAnalysis(goldMineAnalysisRaw);

  console.log(
    `[Discovery] Done: ${compounders.length} compounders, ${goldMines.length} gold mines (${currentTheme.name})`
  );

  const result: DiscoveryResult = {
    compounders,
    goldMines,
    currentTheme,
    timestamp: new Date().toISOString(),
  };

  cacheDiscovery(result);
  onStep?.('done');
  return result;
}

// Auto-clear stale cache from old versions
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('gemini-') && key !== CACHE_KEY) {
      localStorage.removeItem(key);
    }
  }
} catch { /* */ }
