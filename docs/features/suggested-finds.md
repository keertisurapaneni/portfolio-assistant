# Suggested Finds Prompts — Quiet Compounders & Gold Mines

Flow: **HuggingFace (candidates)** → **Finnhub (metrics)** → **HuggingFace (analysis)**.  
Data source: Compounders = Finnhub only. Gold Mines = Finnhub news + metrics.

---

## Architecture Rules (from `aiSuggestedFinds.ts`)

- **Compounders:** ONLY Finnhub structured data. No news, no inferred macro trends.
- **Gold Mines:** Recent market news as primary signal. Facts only — no summaries, no hype.
- **Model:** HuggingFace (Qwen2.5-72B via `huggingface-proxy`)

---

## 1. Quiet Compounders (Steady Compounders)

### Step 1a: Candidate Tickers

**Prompt** (`buildCandidatePrompt`):

```
You are a stock screener. Identify 12 US-listed tickers that could be "Steady Compounders" — AI-proof businesses in boring industries.

Criteria for candidates:
- Boring, unglamorous industries: logistics, waste, utilities, insurance, distribution, industrial services, food distribution, HVAC, pest control, water treatment, specialty chemicals
- Known for consistent profitability and stable operations
- Must NOT be a business at risk of AI disruption (e.g., call centers, manual data entry, commoditized content). AI should be neutral-to-positive for the business.
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks

Return ONLY a JSON array of 12 ticker symbols. No explanations, no other text.
Example: ["ODFL", "POOL", "WSO", "TJX", "WM", "ROL", "FAST"]
```

### Step 2a: Analysis with Finnhub Data

**Prompt** (`buildCompounderAnalysisPrompt`):

```
You are a disciplined stock analyst. Analyze ONLY the Finnhub data provided below.

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

When Finnhub provides Net Debt, EBITDA, Interest Coverage, or Free Cash Flow, include them in the data block. Apply durability penalties only when the metric is present.

FINNHUB DATA:
{{stockDataBlock}}

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

Return 3-8 stocks. Each must have 3 whyGreat points and 3 metrics (P/E must be one of them) — all sourced from the data above. Do NOT fabricate numbers.
```

---

## 2. Gold Mines (Theme-Driven)

### Step 1c: Market News

**Source:** Finnhub `general_news` — last 30 headlines.

### Step 2b-A: Theme + Candidate Tickers from Headlines

**Prompt** (`buildGoldMineCandidatePrompt`):

```
You are a macro-driven stock analyst. Below are real market headlines.

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
{{newsBlock}}

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
}
```

### Step 2b-B: Analysis with Finnhub Data + Headlines

**Prompt** (`buildGoldMineAnalysisPrompt`):

```
You are a disciplined stock analyst. Analyze the Finnhub data below for stocks identified from recent market headlines.

Theme: "{{theme.name}}" — {{theme.description}}

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
{{headlinesSummary}}

FINNHUB DATA:
{{stockDataBlock}}

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

Analyze all stocks provided. Each must have conviction (1-10), valuationTag, 3 whyGreat points, and 3 metrics — all from the Finnhub data above.
```

---

## 3. Category-Focused Discovery

### Compounders by Industry

**Candidate prompt** (`buildCategoryCandidatePrompt`): Same criteria as main compounders, but scoped to a specific industry (e.g., "Industrial Services", "Distribution & Logistics").

**Analysis:** Same as `buildCompounderAnalysisPrompt`.

### Gold Mines by Sector (no news)

**Candidate prompt** (`buildGoldMineCategoryCandidatePrompt`):

```
You are a growth stock screener. Identify 10 US-listed tickers in the "{{category}}" sector that are high-conviction buys with strong near-term catalysts.

Criteria for candidates:
- Must be in or closely related to the "{{category}}" sector
- Strong revenue growth, expanding market, or clear near-term catalyst (product launch, regulatory tailwind, sector momentum)
- Fundamentally sound: profitable or near-profitable, real revenue, competitive moat
- NOT mega-caps: exclude AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, BRK
- NOT penny stocks, SPACs, meme stocks, or speculative turnarounds
- NOT banks, REITs, or ETFs
- Must be liquid US-listed stocks

Return ONLY a JSON array of 10 ticker symbols. No explanations, no other text.
Example: ["CRWD", "PANW", "ZS", "FTNT"]
```

**Analysis** (`buildGoldMineCategoryAnalysisPrompt`): Same structure as Gold Mine analysis, but focused on growth catalysts instead of headlines.

---

## Summary

| Step | Compounders | Gold Mines |
|------|-------------|------------|
| 1 | HuggingFace → 12 tickers (boring industries) | Finnhub news → HuggingFace → theme + 4-6 tickers |
| 2 | Finnhub metrics for candidates | Finnhub metrics for candidates |
| 3 | HuggingFace analysis (facts only) | HuggingFace analysis (catalyst + facts) |

**Output:** Both return `{ ticker, name, tag, reason, category, conviction, valuationTag, whyGreat, metrics }` with `tag` = "Steady Compounder" or "Gold Mine".
