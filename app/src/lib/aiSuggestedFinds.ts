/**
 * AI-Powered Stock Discovery — Grounded in Real Data
 *
 * Architecture:
 *   Steady Compounders: HuggingFace (candidates) → Finnhub (real metrics) → HuggingFace (analysis on facts)
 *   Gold Mines:        Finnhub (market news) → HuggingFace (theme extraction + stock mapping)
 *
 * Data Source Rules:
 *   - Compounders: ONLY Finnhub structured data. No news, no inferred macro trends.
 *   - Gold Mines: Recent market news as primary signal. Facts only — no summaries, no hype.
 *
 * Separation: Groq = Portfolio AI Analysis | HuggingFace = Suggested Finds Discovery
 */

import type { EnhancedSuggestedStock } from '../data/suggestedFinds';

const HUGGINGFACE_PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/huggingface-proxy`;
const STOCK_DATA_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-stock-data`;
const DAILY_SUGGESTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/daily-suggestions`;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Cache config
const PROMPT_VERSION = 10; // v10: ensure conviction scores in theme-driven Gold Mines + cache bust
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

async function callHuggingFace(
  prompt: string,
  type: 'discover_compounders' | 'discover_goldmines' | 'analyze_themes',
  temperature = 0.4,
  maxOutputTokens = 4000,
  retries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(HUGGINGFACE_PROXY_URL, {
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
      throw new Error(`HuggingFace error ${response.status}: ${errData.error || 'Unknown'}`);
    }

    const data = await response.json();
    return data.text ?? '';
  }
  throw new Error('HuggingFace rate-limited after all retries');
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
// Step 1a: HuggingFace suggests compounder candidates (tickers only)
// ──────────────────────────────────────────────────────────

// Industry categories for Steady Compounders — used by dropdown + prompts
export const COMPOUNDER_CATEGORIES = [
  'Industrial Services',
  'Distribution & Logistics',
  'Waste Management',
  'Utilities',
  'Insurance',
  'HVAC & Building Services',
  'Food Distribution',
  'Specialty Chemicals',
  'Water & Environmental',
] as const;

export type CompounderCategory = (typeof COMPOUNDER_CATEGORIES)[number];

// Sector categories for Gold Mines — growth / catalyst-oriented
export const GOLD_MINE_CATEGORIES = [
  'Tech & Software',
  'AI & Semiconductors',
  'Healthcare & Biotech',
  'Clean Energy',
  'Consumer Brands',
  'Financials',
  'Cybersecurity',
  'Defense & Aerospace',
] as const;

export type GoldMineCategory = (typeof GOLD_MINE_CATEGORIES)[number];

function buildCandidatePrompt(excludeTickers: string[]): string {
  const exclude = excludeTickers.length > 0
    ? `\nEXCLUDE these tickers (user already owns them): ${excludeTickers.join(', ')}`
    : '';

  return `You are a stock screener. Identify 12 US-listed tickers that could be "Steady Compounders" — AI-proof businesses in boring industries.

Criteria for candidates:
- Boring, unglamorous industries: logistics, waste, utilities, insurance, distribution, industrial services, food distribution, HVAC, pest control, water treatment, specialty chemicals
- Known for consistent profitability and stable operations
- Must NOT be a business at risk of AI disruption (e.g., call centers, manual data entry, commoditized content). AI should be neutral-to-positive for the business.
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks
${exclude}

Return ONLY a JSON array of 12 ticker symbols. No explanations, no other text.
Example: ["ODFL", "POOL", "WSO", "TJX", "WM", "ROL", "FAST"]`;
}

function buildCategoryCandidatePrompt(category: string, excludeTickers: string[]): string {
  const exclude = excludeTickers.length > 0
    ? `\nEXCLUDE these tickers: ${excludeTickers.join(', ')}`
    : '';

  return `You are a stock screener. Identify 10 US-listed tickers in the "${category}" industry that could be "Steady Compounders" — AI-proof businesses.

Criteria for candidates:
- Must be in or closely related to the "${category}" sector
- Known for consistent profitability and stable operations
- Must NOT be a business at risk of AI disruption. AI should be neutral-to-positive for the business.
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
// Step 2a: HuggingFace analyzes compounders with REAL Finnhub data
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
- A great business at a bad price is NOT a great buy. Consider P/E relative to growth rate. PEG < 1.5 is attractive. P/E below sector average is a plus.
- Always include P/E as one of the 3 visible metrics.

QUALIFYING CRITERIA for Steady Compounders:
- ROE > 12% (proxy for ROIC durability)
- Positive profit margins (net or operating)
- Beta < 1.3 (low volatility, stable business)
- Positive EPS (profitable)
- Consistent revenue or EPS growth is a plus
- Reasonable valuation (P/E not stretched relative to growth)

FINNHUB DATA:
${stockDataBlock}

TASK: Select only the stocks you'd genuinely recommend buying TODAY. Be selective — quality over quantity. Return 3-8 stocks maximum. Only include stocks where BOTH the business quality AND the current valuation make it a genuine buy.

For each stock, assign:
- "conviction" (1-10): How strongly you'd recommend buying NOW, considering both business quality and current valuation
- "valuationTag": One of "Deep Value", "Undervalued", "Fair Value", "Fully Valued" — based on P/E relative to growth (PEG concept) and sector norms
- "aiImpact": One of "Strong Tailwind", "Tailwind", "Neutral" — how AI affects this business
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
      "aiImpact": "Neutral",
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
// Step 2b: HuggingFace extracts themes + stocks from real news
// ──────────────────────────────────────────────────────────

// Step A: HuggingFace extracts tickers + theme from headlines (lightweight — tickers only)
function buildGoldMineCandidatePrompt(news: MarketNewsItem[], excludeTickers: string[]): string {
  const exclude = excludeTickers.length > 0
    ? `\nEXCLUDE these tickers: ${excludeTickers.join(', ')}`
    : '';

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
${exclude}

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

// Step B: HuggingFace analyzes Gold Mine picks with REAL Finnhub data + headline context (same format as Compounders)
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
- Be HONEST about weak metrics — mention them as risks, don't spin them as positives.
- Include ALL stocks provided — let the user decide. Flag risks clearly in whyGreat.
- Sort by conviction (highest first). conviction = 1-10 buy conviction score based on both the catalyst strength AND financial quality.

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
      "conviction": 8,
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

Analyze all stocks provided. Each must have conviction (1-10), 3 whyGreat points, and 3 metrics — all from the Finnhub data above.`;
}

// ──────────────────────────────────────────────────────────
// Gold Mine category-focused prompts (no news dependency)
// ──────────────────────────────────────────────────────────

function buildGoldMineCategoryCandidatePrompt(category: string, excludeTickers: string[]): string {
  const exclude = excludeTickers.length > 0
    ? `\nEXCLUDE these tickers: ${excludeTickers.join(', ')}`
    : '';

  return `You are a growth stock screener. Identify 10 US-listed tickers in the "${category}" sector that are high-conviction buys with strong near-term catalysts.

Criteria for candidates:
- Must be in or closely related to the "${category}" sector
- Strong revenue growth, expanding market, or clear near-term catalyst (product launch, regulatory tailwind, sector momentum)
- Fundamentally sound: profitable or near-profitable, real revenue, competitive moat
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT penny stocks, SPACs, meme stocks, or speculative turnarounds
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks
${exclude}

Return ONLY a JSON array of 10 ticker symbols. No explanations, no other text.
Example: ["CRWD", "PANW", "ZS", "FTNT"]`;
}

function buildGoldMineCategoryAnalysisPrompt(metrics: FinnhubMetricData[], category: string): string {
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

  return `You are a disciplined growth stock analyst. Analyze the Finnhub data below for "${category}" sector stocks.

RULES:
- Use ONLY the Finnhub metrics given. Do not fabricate numbers.
- You MAY fill in company names from your knowledge.
- Focus on GROWTH catalysts: revenue growth, TAM expansion, sector tailwinds, product momentum.
- Each whyGreat point should cite a specific metric from the data.
- Be HONEST about weak metrics — mention them as risks.
- Select 3-6 stocks you'd genuinely recommend. Quality over quantity.
- Sort by conviction (highest first).

FINNHUB DATA:
${stockDataBlock}

TASK: Analyze each stock for the "${category}" sector. Explain why it's a compelling growth pick using real financial data.

Return ONLY valid JSON:
{
  "stocks": [
    {
      "ticker": "SYM",
      "name": "Company Name",
      "tag": "Gold Mine",
      "reason": "One sentence with the growth catalyst and a key metric",
      "category": "${category}",
      "conviction": 8,
      "whyGreat": [
        "Specific metric-backed growth point",
        "Second metric-backed point about the catalyst",
        "Third factual point citing data"
      ],
      "metrics": [
        { "label": "Rev Growth", "value": "35%" },
        { "label": "Gross Margin", "value": "72%" },
        { "label": "Market Cap", "value": "$15B" }
      ]
    }
  ]
}

Each stock must have 3 whyGreat points and 3 metrics from the Finnhub data above. Include "conviction" (1-10).`;
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

  const results = stocks.map((s: Record<string, unknown>) => ({
    ticker: String(s.ticker || '').toUpperCase(),
    name: String(s.name || ''),
    tag: 'Steady Compounder' as const,
    reason: String(s.reason || ''),
    category: s.category ? String(s.category) : undefined,
    conviction: typeof s.conviction === 'number' ? s.conviction : undefined,
    valuationTag: s.valuationTag ? String(s.valuationTag) : undefined,
    aiImpact: s.aiImpact ? String(s.aiImpact) : undefined,
    whyGreat: Array.isArray(s.whyGreat) ? s.whyGreat.map(String) : [],
    metrics: Array.isArray(s.metrics)
      ? (s.metrics as Array<{ label: string; value: string }>).map((m) => ({
          label: String(m.label || ''),
          value: String(m.value || ''),
        }))
      : [],
  }));

  // Sort by conviction (highest first)
  return results.sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
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

  const results = stocks.map((s: Record<string, unknown>) => ({
    ticker: String(s.ticker || '').toUpperCase(),
    name: String(s.name || ''),
    tag: 'Gold Mine' as const,
    reason: String(s.reason || ''),
    category: String(s.category || ''),
    conviction: typeof s.conviction === 'number' ? s.conviction : undefined,
    whyGreat: Array.isArray(s.whyGreat) ? s.whyGreat.map(String) : [],
    metrics: Array.isArray(s.metrics)
      ? (s.metrics as Array<{ label: string; value: string }>).map((m) => ({
          label: String(m.label || ''),
          value: String(m.value || ''),
        }))
      : [],
  }));

  // Sort by conviction when available (category discovery)
  return results.sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
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

  throw new Error('Could not extract tickers from AI response');
}

// ──────────────────────────────────────────────────────────
// Cache management (server-first, localStorage fallback)
// ──────────────────────────────────────────────────────────

// Server-side cache: shared across ALL users for the day
// category param: 'auto' for main discovery, or a slugified category name
async function getServerCachedDiscovery(category = 'auto'): Promise<DiscoveryResult | null> {
  try {
    const url = `${DAILY_SUGGESTIONS_URL}?category=${encodeURIComponent(category)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
    });
    if (!response.ok) return null;

    const result = await response.json();
    if (result.cached && result.data) {
      console.log(`[Discovery] Server cache HIT for ${result.date} category=${category}`);
      return result.data as DiscoveryResult;
    }
  } catch (err) {
    console.warn('[Discovery] Server cache check failed:', err);
  }
  return null;
}

async function storeServerCache(data: DiscoveryResult | EnhancedSuggestedStock[], category = 'auto'): Promise<void> {
  try {
    await fetch(DAILY_SUGGESTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
      body: JSON.stringify({ data, category }),
    });
    console.log(`[Discovery] Stored results in server cache category=${category}`);
  } catch (err) {
    console.warn('[Discovery] Failed to store server cache:', err);
  }
}

// Server cache for category-specific compounder results
async function getServerCachedCategory(categorySlug: string): Promise<EnhancedSuggestedStock[] | null> {
  try {
    const url = `${DAILY_SUGGESTIONS_URL}?category=${encodeURIComponent(categorySlug)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
    });
    if (!response.ok) return null;

    const result = await response.json();
    if (result.cached && result.data) {
      console.log(`[Discovery] Server cache HIT for category=${categorySlug}`);
      return result.data as EnhancedSuggestedStock[];
    }
  } catch (err) {
    console.warn('[Discovery] Category server cache check failed:', err);
  }
  return null;
}

// Local cache: fast fallback for same user within the day
function getLocalCachedDiscovery(): CachedDiscovery | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedDiscovery = JSON.parse(raw);
    const age = Date.now() - new Date(cached.timestamp).getTime();
    if (age < CACHE_DURATION) return cached;
  } catch { /* invalid cache */ }
  return null;
}

function cacheLocalDiscovery(data: DiscoveryResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: new Date().toISOString() }));
  } catch { /* storage full */ }
}

// Category-specific local cache
function getCategoryLocalCacheKey(slug: string): string {
  return `${CACHE_KEY}-cat-${slug}`;
}

function getLocalCachedCategory(slug: string): EnhancedSuggestedStock[] | null {
  try {
    const raw = localStorage.getItem(getCategoryLocalCacheKey(slug));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    const age = Date.now() - new Date(cached.timestamp).getTime();
    if (age < CACHE_DURATION) {
      const data = cached.data as EnhancedSuggestedStock[];
      return data.length > 0 ? data : null; // Treat cached empty results as a miss
    }
  } catch { /* invalid cache */ }
  return null;
}

function cacheLocalCategory(slug: string, data: EnhancedSuggestedStock[]): void {
  try {
    localStorage.setItem(
      getCategoryLocalCacheKey(slug),
      JSON.stringify({ data, timestamp: new Date().toISOString() })
    );
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
  _existingTickers: string[],
  forceRefresh = false,
  onStep?: (step: DiscoveryStep) => void
): Promise<DiscoveryResult> {
  // Cache priority: localStorage (instant) → server (shared) → generate fresh
  if (!forceRefresh) {
    // 1. Local cache (same user, same browser)
    const localCached = getLocalCachedDiscovery();
    if (localCached) {
      console.log('[Discovery] Using local cached results');
      onStep?.('done');
      return localCached.data;
    }

    // 2. Server cache (shared across all users for the day)
    const serverCached = await getServerCachedDiscovery();
    if (serverCached) {
      console.log('[Discovery] Using server-cached results (shared daily)');
      cacheLocalDiscovery(serverCached); // Store locally for fast access
      onStep?.('done');
      return serverCached;
    }
  }

  // 3. No cache — generate fresh (first visitor of the day)
  // Note: We do NOT exclude user-specific tickers during generation
  // because results are shared. Filtering happens on display.
  console.log('[Discovery] No cache found — generating fresh suggestions...');

  // ── QUIET COMPOUNDERS PIPELINE ──

  // Step 1: HuggingFace suggests candidate tickers
  onStep?.('finding_candidates');
  console.log('[Discovery] Step 1: Asking HuggingFace for compounder candidates...');
  const candidateRaw = await callHuggingFace(
    buildCandidatePrompt([]), // No user-specific exclusions for shared cache
    'discover_compounders',
    0.5,
    1000 // Enough room for a JSON array of 10 tickers
  );
  console.log('[Discovery] HuggingFace candidates raw length:', candidateRaw.length);
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

  // Step 3: HuggingFace analyzes with real data
  onStep?.('analyzing_compounders');
  console.log('[Discovery] Step 3: HuggingFace analyzing compounders with real Finnhub data...');

  // 2s pause between HuggingFace calls for rate limit safety
  await new Promise((r) => setTimeout(r, 2000));

  const compounderRaw = await callHuggingFace(
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

  // Step 5a: HuggingFace picks tickers from headlines (lightweight — tickers + theme only)
  onStep?.('analyzing_themes');
  console.log('[Discovery] Step 5a: HuggingFace identifying stocks from headlines...');

  await new Promise((r) => setTimeout(r, 2000));

  const goldMineCandidateRaw = await callHuggingFace(
    buildGoldMineCandidatePrompt(marketNews, []), // No user-specific exclusions for shared cache
    'discover_goldmines',
    0.3,
    1500
  );
  const { theme: currentTheme, candidates: goldMineCandidates } = parseGoldMineCandidates(goldMineCandidateRaw);
  console.log(`[Discovery] Theme: "${currentTheme.name}" — ${goldMineCandidates.length} candidates: ${goldMineCandidates.map(c => c.ticker).join(', ')}`);

  // Step 5b: Fetch real Finnhub metrics for Gold Mine picks + quality filter
  console.log('[Discovery] Step 5b: Fetching Finnhub metrics for Gold Mine picks...');
  const goldMineTickers = goldMineCandidates.map((c) => c.ticker);
  const goldMineMetrics = await fetchMetricsForTickers(goldMineTickers);
  const validGoldMineMetrics = goldMineMetrics.filter(
    (m) => m.roe !== null || m.profitMargin !== null || m.eps !== null
  );
  console.log(`[Discovery] Got metrics for ${validGoldMineMetrics.length}/${goldMineTickers.length} Gold Mine picks`);

  // Step 5c: HuggingFace analyzes Gold Mines with real Finnhub data + headline context
  console.log('[Discovery] Step 5c: HuggingFace analyzing Gold Mines with real data + headlines...');

  await new Promise((r) => setTimeout(r, 2000));

  const goldMineAnalysisRaw = await callHuggingFace(
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

  // Store in both local and server cache
  cacheLocalDiscovery(result);
  storeServerCache(result); // Fire-and-forget — don't block return
  onStep?.('done');
  return result;
}

// ──────────────────────────────────────────────────────────
// Category-focused discovery — compounders only, single industry
// ──────────────────────────────────────────────────────────

function slugifyCategory(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export async function discoverCategoryStocks(
  category: string,
  excludeTickers: string[],
  onStep?: (step: DiscoveryStep) => void
): Promise<EnhancedSuggestedStock[]> {
  const slug = slugifyCategory(category);

  // Cache check: local → server
  const localCached = getLocalCachedCategory(slug);
  if (localCached) {
    console.log(`[Discovery] Category local cache HIT for ${slug}`);
    onStep?.('done');
    return localCached;
  }

  const serverCached = await getServerCachedCategory(slug);
  if (serverCached) {
    console.log(`[Discovery] Category server cache HIT for ${slug}`);
    cacheLocalCategory(slug, serverCached);
    onStep?.('done');
    return serverCached;
  }

  // No cache — run compounder pipeline for this category
  console.log(`[Discovery] No cache for category=${slug} — generating...`);

  // Step 1: Category-focused candidate tickers
  onStep?.('finding_candidates');
  const candidateRaw = await callHuggingFace(
    buildCategoryCandidatePrompt(category, excludeTickers),
    'discover_compounders',
    0.5,
    1000
  );
  const candidateTickers = parseCandidateTickers(candidateRaw);
  console.log(`[Discovery] Category candidates (${slug}): ${candidateTickers.join(', ')}`);

  // Step 2: Fetch Finnhub metrics
  onStep?.('fetching_metrics');
  const metricsData = await fetchMetricsForTickers(candidateTickers);
  const validMetrics = metricsData.filter(
    (m) => m.roe !== null || m.profitMargin !== null || m.eps !== null
  );
  console.log(`[Discovery] Got metrics for ${validMetrics.length}/${candidateTickers.length} (${slug})`);

  // Step 3: Analyze with real data
  onStep?.('analyzing_compounders');
  await new Promise((r) => setTimeout(r, 2000));

  const compounderRaw = await callHuggingFace(
    buildCompounderAnalysisPrompt(validMetrics),
    'discover_compounders',
    0.3,
    4000
  );
  const compounders = parseCompounderResponse(compounderRaw);

  console.log(`[Discovery] Category ${slug} done: ${compounders.length} compounders`);

  // Store in both caches (skip if empty — let the user retry)
  if (compounders.length > 0) {
    cacheLocalCategory(slug, compounders);
    storeServerCache(compounders, slug); // Fire-and-forget
  }

  onStep?.('done');
  return compounders;
}

// ──────────────────────────────────────────────────────────
// Gold Mine category-focused discovery — single sector, catalyst-driven
// ──────────────────────────────────────────────────────────

export async function discoverGoldMineCategoryStocks(
  category: string,
  excludeTickers: string[],
  onStep?: (step: DiscoveryStep) => void
): Promise<EnhancedSuggestedStock[]> {
  const slug = `gm-${slugifyCategory(category)}`;

  // Cache check: local → server
  const localCached = getLocalCachedCategory(slug);
  if (localCached) {
    console.log(`[Discovery] Gold Mine category local cache HIT for ${slug}`);
    onStep?.('done');
    return localCached;
  }

  const serverCached = await getServerCachedCategory(slug);
  if (serverCached) {
    console.log(`[Discovery] Gold Mine category server cache HIT for ${slug}`);
    cacheLocalCategory(slug, serverCached);
    onStep?.('done');
    return serverCached;
  }

  // No cache — run Gold Mine pipeline for this category
  console.log(`[Discovery] No cache for gold mine category=${slug} — generating...`);

  // Step 1: Category-focused candidate tickers
  onStep?.('finding_candidates');
  const candidateRaw = await callHuggingFace(
    buildGoldMineCategoryCandidatePrompt(category, excludeTickers),
    'discover_goldmines',
    0.5,
    1000
  );
  const candidateTickers = parseCandidateTickers(candidateRaw);
  console.log(`[Discovery] Gold Mine category candidates (${slug}): ${candidateTickers.join(', ')}`);

  // Step 2: Fetch Finnhub metrics
  onStep?.('fetching_metrics');
  const metricsData = await fetchMetricsForTickers(candidateTickers);
  const validMetrics = metricsData.filter(
    (m) => m.roe !== null || m.profitMargin !== null || m.eps !== null
  );
  console.log(`[Discovery] Got metrics for ${validMetrics.length}/${candidateTickers.length} (${slug})`);

  // Step 3: Analyze with real data
  onStep?.('analyzing_compounders');
  await new Promise((r) => setTimeout(r, 2000));

  const analysisRaw = await callHuggingFace(
    buildGoldMineCategoryAnalysisPrompt(validMetrics, category),
    'discover_goldmines',
    0.3,
    4000
  );
  const goldMines = parseGoldMineAnalysis(analysisRaw);

  console.log(`[Discovery] Gold Mine category ${slug} done: ${goldMines.length} picks`);

  // Store in both caches (skip if empty — let the user retry)
  if (goldMines.length > 0) {
    cacheLocalCategory(slug, goldMines);
    storeServerCache(goldMines, slug); // Fire-and-forget
  }

  onStep?.('done');
  return goldMines;
}

// Auto-clear stale cache from old versions
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('gemini-') && key !== CACHE_KEY && !key.startsWith(`${CACHE_KEY}-cat-`)) {
      localStorage.removeItem(key);
    }
  }
} catch { /* */ }
