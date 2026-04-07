/**
 * Server-side Suggested Finds Discovery.
 *
 * Mirrors the browser pipeline in app/src/lib/aiSuggestedFinds.ts but runs
 * headless in the auto-trader service. Calls the same Supabase edge functions:
 *   - huggingface-proxy (AI: HuggingFace Inference API)
 *   - fetch-stock-data  (Data: Finnhub metrics + news)
 *   - daily-suggestions (Cache: shared across all users)
 *
 * No new API keys or edge functions needed.
 */

import { getSupabaseUrl, getSupabaseAnonKey } from './supabase.js';

// ── Types ────────────────────────────────────────────────

interface ThemeData {
  name: string;
  description: string;
  categories: { name: string; description: string }[];
}

interface SuggestedStock {
  ticker: string;
  name: string;
  tag: 'Steady Compounder' | 'Gold Mine';
  reason: string;
  category?: string;
  conviction?: number;
  valuationTag?: string;
  whyGreat: string[];
  metrics: { label: string; value: string }[];
}

interface DiscoveryResult {
  compounders: SuggestedStock[];
  goldMines: SuggestedStock[];
  currentTheme: ThemeData;
  timestamp: string;
}

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
  netDebt: number | null;
  ebitda: number | null;
  interestCoverage: number | null;
  freeCashFlow: number | null;
}

interface MarketNewsItem {
  headline: string;
  source: string;
  datetime: number;
  summary?: string;
}

// ── Edge function callers ────────────────────────────────

async function callHuggingFace(
  prompt: string,
  type: 'discover_compounders' | 'discover_goldmines' | 'analyze_themes',
  temperature = 0.4,
  maxOutputTokens = 4000,
  retries = 3,
): Promise<string> {
  const url = `${getSupabaseUrl()}/functions/v1/huggingface-proxy`;
  const key = getSupabaseAnonKey();

  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt, type, temperature, maxOutputTokens }),
    });

    if (res.status === 429) {
      const waitSec = attempt * 5;
      console.warn(`[Discovery] 429 (attempt ${attempt}/${retries}), waiting ${waitSec}s...`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown' }));
      throw new Error(`HuggingFace error ${res.status}: ${err.error || 'Unknown'}`);
    }

    const data = await res.json();
    return data.text ?? '';
  }
  throw new Error('HuggingFace rate-limited after all retries');
}

async function fetchFinnhub(
  ticker: string,
  endpoint: 'metrics' | 'quote' | 'general_news',
): Promise<Record<string, unknown> | null> {
  try {
    const url = `${getSupabaseUrl()}/functions/v1/fetch-stock-data`;
    const key = getSupabaseAnonKey();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ ticker, endpoint }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Finnhub metrics fetcher ──────────────────────────────

async function fetchMetricsForTickers(tickers: string[]): Promise<FinnhubMetricData[]> {
  const results: FinnhubMetricData[] = [];
  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const batchResults = await Promise.all(
      batch.map(async (ticker) => {
        const data = await fetchFinnhub(ticker, 'metrics');
        if (!data) return null;
        const m = (data as { metric?: Record<string, number> }).metric || {};
        const num = (v: unknown): number | null =>
          typeof v === 'number' && !Number.isNaN(v) ? v : null;
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
          netDebt: num(m.netDebt ?? m.netDebtTTM),
          ebitda: num(m.ebitda ?? m.ebitdaTTM),
          interestCoverage: num(m.interestCoverage ?? m.interestCoverageTTM),
          freeCashFlow: num(m.freeCashFlow ?? m.freeCashFlowTTM ?? m.fcf),
        } as FinnhubMetricData;
      }),
    );
    results.push(...batchResults.filter((r): r is FinnhubMetricData => r !== null));
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// ── Market news fetcher ──────────────────────────────────

async function fetchGeneralMarketNews(): Promise<MarketNewsItem[]> {
  const data = await fetchFinnhub('_MARKET', 'general_news');
  if (!data) return [];
  const items = Array.isArray(data) ? data : Object.values(data);
  if (!Array.isArray(items)) return [];
  return items
    .filter((n: unknown) => {
      const item = n as Record<string, unknown>;
      return typeof item.headline === 'string' && (item.headline as string).length > 0;
    })
    .slice(0, 30)
    .map((n: unknown) => {
      const item = n as Record<string, unknown>;
      return {
        headline: String(item.headline || ''),
        source: String(item.source || ''),
        datetime: Number(item.datetime || 0),
        summary: item.summary ? String(item.summary) : undefined,
      };
    });
}

// ── Prompt builders (mirror browser's aiSuggestedFinds.ts) ──

function buildCandidatePrompt(): string {
  return `You are a stock screener. Identify 12 US-listed tickers that could be "Steady Compounders" — AI-proof businesses in boring industries.

Criteria for candidates:
- Boring, unglamorous industries: logistics, waste, utilities, insurance, distribution, industrial services, food distribution, HVAC, pest control, water treatment, specialty chemicals
- Known for consistent profitability and stable operations
- Must NOT be a business at risk of AI disruption (e.g., call centers, manual data entry, commoditized content). AI should be neutral-to-positive for the business.
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks

Return ONLY a JSON array of 12 ticker symbols. No explanations, no other text.
Example: ["ODFL", "POOL", "WSO", "TJX", "WM", "ROL", "FAST"]`;
}

function formatMetricsBlock(metrics: FinnhubMetricData[]): string {
  return metrics
    .map(m => {
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
      if (m.netDebt !== null) lines.push(`  Net Debt: $${(m.netDebt / 1e6).toFixed(2)}M`);
      if (m.ebitda !== null) lines.push(`  EBITDA: $${(m.ebitda / 1e6).toFixed(2)}M`);
      if (m.interestCoverage !== null) lines.push(`  Interest Coverage: ${m.interestCoverage.toFixed(1)}x`);
      if (m.freeCashFlow !== null) lines.push(`  Free Cash Flow: $${(m.freeCashFlow / 1e6).toFixed(2)}M`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildCompounderAnalysisPrompt(metrics: FinnhubMetricData[]): string {
  return `You are a disciplined stock analyst. Analyze ONLY the Finnhub data provided below.

RULES:
- Use ONLY the metrics given for analysis. Do not infer, estimate, or fabricate any metrics.
- You MAY fill in company names from your knowledge (e.g., FAST = Fastenal, WM = Waste Management).
- Do not reference news, macro trends, or market sentiment.
- Be concise and factual. No narratives, hype, or storytelling.
- If a metric is missing, note it — do not guess.
- A great business at a bad price is NOT a great buy. Consider P/E relative to growth rate. PEG < 1.5 is attractive. P/E below sector average is a plus.
- Always include P/E as one of the 3 visible metrics.

DURABILITY PENALTY (apply ONLY when data is present; do not fabricate missing metrics):
- If Net Debt and EBITDA are both present and NetDebt/EBITDA > 3 → reduce conviction by 2.
- If Interest Coverage is present and < 4 → reduce conviction by 2.
- If Free Cash Flow is present and negative (most recent year) → reduce conviction by 2.

QUALIFYING CRITERIA for Steady Compounders:
- ROE > 12% (proxy for ROIC durability)
- Positive profit margins (net or operating)
- Beta < 1.3 (low volatility, stable business)
- Positive EPS (profitable)
- Consistent revenue or EPS growth is a plus
- Reasonable valuation (P/E not stretched relative to growth)

FINNHUB DATA:
${formatMetricsBlock(metrics)}

TASK: Select only the stocks you'd genuinely recommend buying TODAY. Be selective — quality over quantity. Return 3-8 stocks maximum. Only include stocks where BOTH the business quality AND the current valuation make it a genuine buy.

For each stock, assign:
- "conviction" (1-10): How strongly you'd recommend buying NOW, considering both business quality and current valuation
- "valuationTag": One of "Deep Value", "Undervalued", "Fair Value", "Fully Valued" — based on P/E relative to growth (PEG concept) and sector norms
- "category": The industry category (e.g., "Industrial Services", "Distribution & Logistics", "Waste Management", "Utilities", "Insurance", "HVAC & Building Services", "Food Distribution", "Specialty Chemicals", "Water & Environmental")

Return stocks sorted by conviction (highest first).

Return ONLY valid JSON:
{
  "stocks": [
    {
      "ticker": "SYM",
      "name": "Company Name",
      "tag": "Steady Compounder",
      "reason": "One factual sentence citing specific metrics from the data above",
      "category": "Industry Category",
      "conviction": 9,
      "valuationTag": "Undervalued",
      "whyGreat": [
        "Specific metric-backed point (e.g. 'ROE of 22% indicates durable capital efficiency')",
        "Second metric-backed point",
        "Third metric-backed point"
      ],
      "metrics": [
        { "label": "P/E", "value": "18.5" },
        { "label": "ROE", "value": "22%" },
        { "label": "Profit Margin", "value": "15%" }
      ]
    }
  ]
}

Return 3-8 stocks. Each must have 3 whyGreat points and 3 metrics (P/E must be one of them) — all sourced from the data above. Do NOT fabricate numbers.`;
}

function buildGoldMineCandidatePrompt(news: MarketNewsItem[]): string {
  const newsBlock = news
    .map((n, i) => {
      const date = new Date(n.datetime * 1000).toISOString().split('T')[0];
      return `${i + 1}. [${date}] ${n.headline} (${n.source})`;
    })
    .join('\n');

  return `You are a macro-driven stock analyst. Below are real market headlines.

Your job: identify the DOMINANT investable macro theme from these headlines, then recommend 4-6 QUALITY stocks that are the best ways to play that theme.

APPROACH:
1. Read all headlines and identify the strongest macro theme (e.g., "AI infrastructure spending surge", "Healthcare cost reform", "Energy transition acceleration", "Defense spending ramp").
2. Then pick 4-6 well-run, fundamentally sound companies that BENEFIT from this theme.
3. These do NOT need to be mentioned in the headlines — they need to be the BEST companies positioned for the theme.

STOCK SELECTION RULES:
- DIVERSIFY across the VALUE CHAIN of whatever theme you identify. Don't cluster picks in one niche.
  Example: if the theme were infrastructure spending, you'd pick across construction, materials, engineering, equipment, logistics — not 6 construction companies.
  Example: if the theme were an energy transition, you'd pick across solar, storage, grid tech, utilities, mining — not 6 solar companies.
- Each pick should be from a DIFFERENT part of the value chain — no two stocks from the same niche.
- Pick companies with strong businesses: profitable or near-profitable, growing revenue, clear competitive moat.
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK.
- NOT penny stocks, SPACs, or speculative turnarounds.
- NOT stocks that are merely in the news because they're crashing.
- Think like an investor: "If this theme plays out over 6-12 months, which quality companies across the entire ecosystem win?"

HEADLINES:
${newsBlock}

Return ONLY valid JSON:
{
  "theme": {
    "name": "Theme Name",
    "description": "1-2 sentences explaining the macro catalyst from the headlines",
    "categories": [
      { "name": "Sub-theme", "description": "Brief description" }
    ]
  },
  "tickers": [
    { "ticker": "SYM", "name": "Company Name", "category": "Sub-theme", "headline_ref": "Which headlines support the theme", "catalyst": "Why this company benefits from the theme" }
  ]
}`;
}

function buildGoldMineAnalysisPrompt(
  metrics: FinnhubMetricData[],
  news: MarketNewsItem[],
  candidates: Array<{ ticker: string; name: string; category: string; headline_ref: string }>,
  theme: ThemeData,
): string {
  const stockDataBlock = metrics
    .map(m => {
      const candidate = candidates.find(c => c.ticker === m.ticker);
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
- Be HONEST about weak metrics — mention them as risks, don't spin them as positives.
- Include ALL stocks provided — let the user decide. Flag risks clearly in whyGreat.
- Sort by conviction (highest first). conviction = 1-10 buy conviction score based on both the catalyst strength AND financial quality.

THEME HEADLINE SUPPORT (apply before final conviction):
- Count how many separate headlines support or reference the dominant theme.
- If theme referenced in < 3 separate headlines → reduce conviction of all stocks by 2.
- If theme appears only once → cap max conviction at 7.

RECENT HEADLINES (for context):
${headlinesSummary}

FINNHUB DATA:
${stockDataBlock}

TASK: Analyze each stock. For each, explain WHY it's interesting using BOTH the headline catalyst AND the real financial metrics.

For each stock, assign:
- "conviction" (1-10): How strongly you'd recommend buying NOW, considering both the catalyst AND financial quality
- "valuationTag": One of "Deep Value", "Undervalued", "Fair Value", "Fully Valued" — based on P/E relative to growth (PEG concept) and sector norms

Return ONLY valid JSON:
{
  "stocks": [
    {
      "ticker": "SYM",
      "name": "Company Name",
      "tag": "Gold Mine",
      "reason": "One sentence combining the headline catalyst with a key financial metric",
      "category": "Value chain category",
      "conviction": 8,
      "valuationTag": "Undervalued",
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

Analyze all stocks provided. Each must have conviction (1-10), valuationTag, 3 whyGreat points, and 3 metrics — all from the Finnhub data above.`;
}

// ── Parsers ──────────────────────────────────────────────

function cleanJSON(raw: string): string {
  return raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
}

function parseCandidateTickers(raw: string): string[] {
  const cleaned = cleanJSON(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.map((t: string) => String(t).toUpperCase());
    if (parsed.tickers && Array.isArray(parsed.tickers))
      return parsed.tickers.map((t: string) => String(t).toUpperCase());
    if (parsed.stocks && Array.isArray(parsed.stocks))
      return parsed.stocks.map((s: unknown) =>
        typeof s === 'string' ? s.toUpperCase() : String((s as Record<string, unknown>).ticker || '').toUpperCase(),
      );
  } catch { /* fallback below */ }

  const matches = cleaned.match(/\b[A-Z]{1,5}\b/g);
  if (matches && matches.length >= 3) {
    const skipWords = new Set(['THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'HAS', 'WAS', 'ALL', 'CAN', 'HAD', 'HER', 'ONE', 'OUR', 'OUT', 'YOU', 'DAY', 'GET', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'BOY', 'DID', 'USE', 'SAY', 'SHE', 'TWO', 'SET', 'JSON', 'ONLY', 'ALSO', 'WITH', 'FROM', 'JUST', 'LIKE', 'THEM', 'THAN', 'EACH', 'MAKE']);
    return matches.filter(m => !skipWords.has(m)).slice(0, 12);
  }
  throw new Error('Could not extract tickers from AI response');
}

function parseStocksResponse(raw: string, tag: 'Steady Compounder' | 'Gold Mine'): SuggestedStock[] {
  const parsed = JSON.parse(cleanJSON(raw));
  const stocks = parsed.stocks || parsed;
  if (!Array.isArray(stocks)) throw new Error('Expected stocks array');

  return stocks
    .map((s: Record<string, unknown>) => ({
      ticker: String(s.ticker || '').toUpperCase(),
      name: String(s.name || ''),
      tag,
      reason: String(s.reason || ''),
      category: s.category ? String(s.category) : undefined,
      conviction: typeof s.conviction === 'number' ? s.conviction : undefined,
      valuationTag: s.valuationTag ? String(s.valuationTag) : undefined,
      whyGreat: Array.isArray(s.whyGreat) ? s.whyGreat.map(String) : [],
      metrics: Array.isArray(s.metrics)
        ? (s.metrics as Array<{ label: string; value: string }>).map(m => ({
            label: String(m.label || ''),
            value: String(m.value || ''),
          }))
        : [],
    }))
    .sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
}

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

// ── Cache writer ─────────────────────────────────────────

async function storeServerCache(data: DiscoveryResult): Promise<void> {
  try {
    const url = `${getSupabaseUrl()}/functions/v1/daily-suggestions`;
    const key = getSupabaseAnonKey();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ data, category: 'auto' }),
    });
    console.log('[Discovery] Stored results in server cache');
  } catch (err) {
    console.warn('[Discovery] Failed to store server cache:', err);
  }
}

// ── Main orchestrator ────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function generateSuggestedFinds(): Promise<DiscoveryResult> {
  console.log('[Discovery] Generating fresh Suggested Finds (server-side)...');

  // ── QUIET COMPOUNDERS PIPELINE ──

  console.log('[Discovery] Step 1: HuggingFace compounder candidates...');
  const candidateRaw = await callHuggingFace(buildCandidatePrompt(), 'discover_compounders', 0.5, 1000);
  const candidateTickers = parseCandidateTickers(candidateRaw);
  console.log(`[Discovery] Candidates: ${candidateTickers.join(', ')}`);

  console.log('[Discovery] Step 2: Fetching Finnhub metrics...');
  const metricsData = await fetchMetricsForTickers(candidateTickers);
  const validMetrics = metricsData.filter(m => m.roe !== null || m.profitMargin !== null || m.eps !== null);
  console.log(`[Discovery] Got metrics for ${validMetrics.length}/${candidateTickers.length} tickers`);

  await sleep(2000);

  console.log('[Discovery] Step 3: HuggingFace analyzing compounders...');
  const compounderRaw = await callHuggingFace(buildCompounderAnalysisPrompt(validMetrics), 'discover_compounders', 0.3, 4000);
  const compounders = parseStocksResponse(compounderRaw, 'Steady Compounder');

  // ── GOLD MINES PIPELINE ──

  console.log('[Discovery] Step 4: Fetching market news...');
  const marketNews = await fetchGeneralMarketNews();
  console.log(`[Discovery] Got ${marketNews.length} headlines`);

  await sleep(2000);

  console.log('[Discovery] Step 5a: HuggingFace identifying Gold Mine theme + tickers...');
  const goldMineCandidateRaw = await callHuggingFace(buildGoldMineCandidatePrompt(marketNews), 'discover_goldmines', 0.3, 1500);
  const { theme: currentTheme, candidates: goldMineCandidates } = parseGoldMineCandidates(goldMineCandidateRaw);
  console.log(`[Discovery] Theme: "${currentTheme.name}" — ${goldMineCandidates.length} candidates`);

  console.log('[Discovery] Step 5b: Fetching Finnhub metrics for Gold Mines...');
  const goldMineMetrics = await fetchMetricsForTickers(goldMineCandidates.map(c => c.ticker));
  const validGoldMineMetrics = goldMineMetrics.filter(m => m.roe !== null || m.profitMargin !== null || m.eps !== null);

  await sleep(2000);

  console.log('[Discovery] Step 5c: HuggingFace analyzing Gold Mines...');
  const goldMineRaw = await callHuggingFace(
    buildGoldMineAnalysisPrompt(validGoldMineMetrics, marketNews, goldMineCandidates, currentTheme),
    'discover_goldmines', 0.3, 4000,
  );
  const goldMines = parseStocksResponse(goldMineRaw, 'Gold Mine');

  console.log(`[Discovery] Done: ${compounders.length} compounders, ${goldMines.length} gold mines (${currentTheme.name})`);

  const result: DiscoveryResult = {
    compounders,
    goldMines,
    currentTheme,
    timestamp: new Date().toISOString(),
  };

  // Store in server cache so browser gets instant results
  await storeServerCache(result);

  return result;
}
