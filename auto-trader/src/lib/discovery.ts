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
import { fetchDailyBars } from './yahoo-finance.js';

// ── Types ────────────────────────────────────────────────

interface ThemeData {
  name: string;
  description: string;
  categories: { name: string; description: string }[];
}

interface SuggestedStock {
  ticker: string;
  name: string;
  tag: 'Steady Compounder' | 'Gold Mine' | 'Dip Discovery';
  reason: string;
  category?: string;
  conviction?: number;
  valuationTag?: string;
  whyGreat: string[];
  metrics: { label: string; value: string }[];
  high52w?: number;
  drawdownPct?: number;
  sector?: string;
}

interface DiscoveryResult {
  compounders: SuggestedStock[];
  goldMines: SuggestedStock[];
  dipDiscoveries: SuggestedStock[];
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
  type: 'discover_compounders' | 'discover_goldmines' | 'discover_dips' | 'analyze_themes',
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

// Well-known stalwarts excluded so the AI discovers less-covered quality names
const COMPOUNDER_STALWARTS = [
  'ODFL', 'WM', 'RSG', 'ROL', 'FAST', 'POOL', 'WSO', 'TJX', 'CTAS', 'ECL',
  'AWK', 'ATO', 'NI', 'SR', 'NWN', 'SJW', 'WTRG', 'MSEX',
];

function buildCandidatePrompt(): string {
  const exclude = `\nEXCLUDE these tickers — they are too well-known to be a discovery: ${COMPOUNDER_STALWARTS.join(', ')}`;

  return `You are a stock screener. Your goal is to DISCOVER overlooked, under-followed US-listed tickers that could be "Steady Compounders" — AI-proof businesses in boring industries.

Criteria for candidates:
- Boring, unglamorous industries: logistics, waste, utilities, insurance, distribution, industrial services, food distribution, HVAC, pest control, water treatment, specialty chemicals, auto parts distribution, facilities services, testing & inspection
- Known for consistent profitability and stable operations
- Must NOT be a business at risk of AI disruption (e.g., call centers, manual data entry, commoditized content). AI should be neutral-to-positive for the business.
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks
- PRIORITIZE: smaller, less-covered quality compounders that analysts rarely spotlight — NOT the perennial favorites
- DIVERSIFY across industries: return candidates from at least 6 different industries
${exclude}

Return ONLY a JSON array of 12 ticker symbols. No explanations, no other text.`;
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

// ── Dip Discovery Pipeline ───────────────────────────────
// Finds S&P 500 / Fortune 500 stocks that have dropped 30-50% from their
// 52-week high and show signs of stabilization (price > 10-day SMA).
// AI identifies candidates; Finnhub data verifies drawdown and stabilization.

import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';

interface DipCandidate {
  ticker: string;
  name: string;
  reason: string;
  sector: string;
}

async function finnhubGet<T>(path: string): Promise<T | null> {
  return finnhubFetch<T>(`https://finnhub.io/api/v1${path}&token=${FINNHUB_KEY}`);
}

function buildDipCandidatePrompt(): string {
  return `You are a quantitative equity screener. Identify US-listed S&P 500 or Fortune 500 companies whose stock price has FALLEN 30% to 50% from its 52-week high.

Requirements:
- Must be an S&P 500 constituent OR a Fortune 500 company (market cap > $10B)
- Current price is 30-50% BELOW the stock's 52-week high (a significant drawdown)
- The decline should be RECENT (within the last 4-16 weeks, not a slow multi-year bleed)
- The reason for the dip should be TEMPORARY — earnings miss with intact guidance, sector rotation, macro selloff, tariff fear, management transition with strong successor
- The company's COMPETITIVE MOAT must be INTACT — not threatened by AI disruption, geopolitical realignment, or secular industry decline

HARD EXCLUDES (do NOT suggest these):
- Companies whose core product is being commoditized by AI (e.g., creative software replaced by generative AI, basic data services replaced by LLMs, routine consulting replaced by AI agents)
- Companies with unresolvable geopolitical supply chain risk (>50% revenue dependent on adversarial-nation trade)
- Secular decline industries (legacy media, fossil-only energy without transition plan, declining retail)
- Accounting fraud, credit downgrade to junk, product safety crisis

PREFER companies with:
- Physical infrastructure moats (pipelines, railroads, data centers, power plants)
- Regulatory moats (licensed utilities, defense contractors, healthcare monopolies)
- Network effects that AI cannot replicate (payment networks, exchanges, social platforms with real identity)
- Mission-critical enterprise software with deep integration (ERP, core banking)

Return ONLY a JSON array of objects with these fields:
{
  "candidates": [
    { "ticker": "XYZ", "name": "Company Name", "reason": "Brief reason for the dip", "sector": "GICS sector" }
  ]
}

Return 5-15 candidates. No explanations outside the JSON.`;
}

function buildDipCatalystPrompt(candidates: Array<{ ticker: string; name: string; reason: string; drawdownPct: number }>): string {
  const stockList = candidates.map(c =>
    `${c.ticker} (${c.name}): Down ${c.drawdownPct.toFixed(0)}% — ${c.reason}`
  ).join('\n');

  return `You are a skeptical equity analyst specializing in moat durability. For each stock below, determine whether the dip is a BUYING OPPORTUNITY or a VALUE TRAP.

Stocks:
${stockList}

For each stock, rigorously analyze these five dimensions:

1. MOAT DURABILITY — Is the company's competitive advantage DURABLE or ERODING?
   - AI disruption: Can AI tools replicate or commoditize their core product/service? (e.g., creative software vs AI generation, data services vs LLMs, consulting vs AI agents)
   - Network effects: Are switching costs still high, or are alternatives emerging?
   - If AI meaningfully threatens their moat within 3 years → AVOID

2. GEOPOLITICAL & REGULATORY RISK
   - Supply chain dependency on adversarial nations (China, Russia)
   - Tariff exposure, sanctions risk, export controls
   - Pending antitrust or regulatory action that could force restructuring
   - If geopolitical risk could permanently impair revenue >20% → AVOID

3. SECULAR vs CYCLICAL — Is the industry growing or shrinking?
   - Secular decline (print media, legacy telecom, fossil-only energy) → AVOID
   - Cyclical downturn in a growing industry (semiconductors, cloud) → potential BUY

4. FINANCIAL RESILIENCE
   - Can the company self-fund through the recovery? (cash flow positive, manageable debt)
   - Is there dividend coverage, buyback capacity, or does it need to raise capital?

5. RECOVERY CATALYST — What specific event will drive the stock back up?
   - Earnings inflection, new product cycle, cost restructuring, M&A, management change
   - If no clear catalyst within 6-12 months → AVOID

VERDICT RULES:
- AVOID if moat is being disrupted by AI (even if financials look cheap)
- AVOID if geopolitical risk is unresolvable by management
- AVOID if no clear recovery catalyst within 12 months
- BUY only if moat is INTACT, dip cause is TEMPORARY, and recovery catalyst is IDENTIFIABLE
- Be harsh — most dips are value traps. Only recommend BUY for truly resilient businesses.

Return ONLY a JSON array:
{
  "stocks": [
    {
      "ticker": "XYZ",
      "name": "Company Name",
      "verdict": "BUY" or "AVOID",
      "conviction": 1-10,
      "reason": "One-sentence thesis for buy/avoid",
      "whyGreat": ["point 1 citing moat strength", "point 2 citing recovery catalyst", "point 3 citing financial resilience"],
      "metrics": [{"label": "P/E", "value": "12.3"}, {"label": "Market Cap", "value": "$45B"}, {"label": "Drawdown", "value": "-35%"}],
      "valuationTag": "Deep Value" or "Undervalued" or "Fair Value"
    }
  ]
}`;
}

function parseDipCandidates(raw: string): DipCandidate[] {
  const cleaned = cleanJSON(raw);
  try {
    const parsed = JSON.parse(cleaned);
    const arr = parsed.candidates || parsed.stocks || parsed;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c: Record<string, unknown>) => c.ticker && typeof c.ticker === 'string')
      .map((c: Record<string, unknown>) => ({
        ticker: String(c.ticker).toUpperCase(),
        name: String(c.name || ''),
        reason: String(c.reason || ''),
        sector: String(c.sector || 'Unknown'),
      }));
  } catch {
    const matches = cleaned.match(/\b[A-Z]{1,5}\b/g);
    if (matches && matches.length >= 3) {
      const skipWords = new Set(['THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'JSON', 'ONLY', 'ALSO', 'WITH', 'FROM']);
      return matches.filter(m => !skipWords.has(m)).slice(0, 15).map(t => ({
        ticker: t, name: '', reason: '', sector: 'Unknown',
      }));
    }
    return [];
  }
}

function parseDipAnalysis(raw: string): SuggestedStock[] {
  const cleaned = cleanJSON(raw);
  const parsed = JSON.parse(cleaned);
  const stocks = parsed.stocks || parsed;
  if (!Array.isArray(stocks)) return [];

  return stocks
    .filter((s: Record<string, unknown>) => String(s.verdict || '').toUpperCase() === 'BUY')
    .map((s: Record<string, unknown>) => ({
      ticker: String(s.ticker || '').toUpperCase(),
      name: String(s.name || ''),
      tag: 'Dip Discovery' as const,
      reason: String(s.reason || ''),
      conviction: typeof s.conviction === 'number' ? s.conviction : 7,
      valuationTag: s.valuationTag ? String(s.valuationTag) : 'Deep Value',
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

export async function discoverDipStocks(): Promise<SuggestedStock[]> {
  if (!FINNHUB_KEY) {
    console.warn('[DipDiscovery] No FINNHUB_API_KEY — skipping');
    return [];
  }

  console.log('[DipDiscovery] Step 1: AI identifying dip candidates...');
  const candidateRaw = await callHuggingFace(buildDipCandidatePrompt(), 'discover_dips', 0.3, 2000);
  const candidates = parseDipCandidates(candidateRaw);
  console.log(`[DipDiscovery] AI suggested ${candidates.length} candidates: ${candidates.map(c => c.ticker).join(', ')}`);

  if (candidates.length === 0) return [];

  // Step 2: Verify drawdown with Finnhub data
  console.log('[DipDiscovery] Step 2: Verifying drawdown with Finnhub data...');
  const verified: Array<DipCandidate & { high52w: number; price: number; drawdownPct: number; marketCap: number; eps: number }> = [];

  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const results = await Promise.all(batch.map(async (c) => {
      const [metrics, quote] = await Promise.all([
        finnhubGet<{ metric?: Record<string, number> }>(`/stock/metric?symbol=${c.ticker}&metric=all`),
        finnhubGet<{ c?: number }>(`/quote?symbol=${c.ticker}`),
      ]);

      const m = metrics?.metric ?? {};
      const high52w = m['52WeekHigh'] ?? 0;
      const price = quote?.c ?? 0;
      const marketCap = m.marketCapitalization ?? 0;
      const eps = m.epsTTM ?? m.epsAnnual ?? 0;

      if (!high52w || !price || high52w <= 0 || price <= 0) return null;

      const drawdownPct = ((high52w - price) / high52w) * 100;
      if (drawdownPct < 30 || drawdownPct > 50) return null;
      if (marketCap < 10000) return null; // < $10B (Finnhub reports in millions)
      if (eps <= 0) return null;

      return { ...c, high52w, price, drawdownPct, marketCap, eps };
    }));

    verified.push(...results.filter((r): r is NonNullable<typeof results[number]> => r !== null));
    if (i + 3 < candidates.length) await sleep(400);
  }

  console.log(`[DipDiscovery] ${verified.length} pass drawdown/fundamentals filter: ${verified.map(v => `${v.ticker}(-${v.drawdownPct.toFixed(0)}%)`).join(', ')}`);
  if (verified.length === 0) return [];

  // Step 3: Check 10-day SMA stabilization
  console.log('[DipDiscovery] Step 3: Checking 10-day SMA stabilization...');
  const stabilized: typeof verified = [];

  for (const stock of verified) {
    const bars = await fetchDailyBars(stock.ticker, '1mo');
    const closes = bars?.map(b => b.close).filter((v): v is number => v > 0) ?? [];

    if (closes.length < 10) {
      console.log(`  ${stock.ticker}: insufficient candle data (${closes.length} bars)`);
      continue;
    }

    const last10 = closes.slice(-10);
    const sma10 = last10.reduce((a, b) => a + b, 0) / last10.length;
    const currentClose = closes[closes.length - 1];

    if (currentClose < sma10) {
      console.log(`  ${stock.ticker}: below 10-day SMA ($${currentClose.toFixed(2)} < $${sma10.toFixed(2)}) — still bleeding`);
      continue;
    }

    console.log(`  ${stock.ticker}: above 10-day SMA ($${currentClose.toFixed(2)} > $${sma10.toFixed(2)}) — stabilized`);
    stabilized.push(stock);
    await sleep(300);
  }

  if (stabilized.length === 0) {
    console.log('[DipDiscovery] No candidates passed SMA stabilization check');
    return [];
  }

  // Step 4: AI catalyst analysis — buy or avoid?
  console.log(`[DipDiscovery] Step 4: AI catalyst analysis for ${stabilized.length} stocks...`);
  const catalystRaw = await callHuggingFace(
    buildDipCatalystPrompt(stabilized),
    'discover_dips', 0.3, 4000,
  );
  const analyzed = parseDipAnalysis(catalystRaw);

  // Attach Finnhub-verified data to the results
  for (const stock of analyzed) {
    const match = stabilized.find(s => s.ticker === stock.ticker);
    if (match) {
      stock.high52w = match.high52w;
      stock.drawdownPct = match.drawdownPct;
      stock.sector = match.sector;
    }
  }

  console.log(`[DipDiscovery] Final: ${analyzed.length} buy candidates — ${analyzed.map(s => s.ticker).join(', ')}`);
  return analyzed;
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
  const candidateRaw = await callHuggingFace(buildCandidatePrompt(), 'discover_compounders', 0.7, 1000);
  const candidateTickers = parseCandidateTickers(candidateRaw);
  console.log(`[Discovery] Candidates: ${candidateTickers.join(', ')}`);

  console.log('[Discovery] Step 2: Fetching Finnhub metrics...');
  const metricsData = await fetchMetricsForTickers(candidateTickers);
  const validMetrics = metricsData.filter(m => m.roe !== null || m.profitMargin !== null || m.eps !== null);
  console.log(`[Discovery] Got metrics for ${validMetrics.length}/${candidateTickers.length} tickers`);

  await sleep(2000);

  console.log('[Discovery] Step 3: HuggingFace analyzing compounders...');
  const compounderRaw = await callHuggingFace(buildCompounderAnalysisPrompt(validMetrics), 'discover_compounders', 0.3, 8000);
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
    'discover_goldmines', 0.3, 8000,
  );
  const goldMines = parseStocksResponse(goldMineRaw, 'Gold Mine');

  // ── DIP DISCOVERY PIPELINE ──
  console.log('[Discovery] Step 6: Dip Discovery scan...');
  let dipDiscoveries: SuggestedStock[] = [];
  try {
    dipDiscoveries = await discoverDipStocks();
  } catch (err) {
    console.warn(`[Discovery] Dip Discovery failed (non-blocking): ${err instanceof Error ? err.message : 'unknown'}`);
  }

  console.log(`[Discovery] Done: ${compounders.length} compounders, ${goldMines.length} gold mines (${currentTheme.name}), ${dipDiscoveries.length} dip discoveries`);

  const result: DiscoveryResult = {
    compounders,
    goldMines,
    dipDiscoveries,
    currentTheme,
    timestamp: new Date().toISOString(),
  };

  // Store in server cache so browser gets instant results
  await storeServerCache(result);

  return result;
}
