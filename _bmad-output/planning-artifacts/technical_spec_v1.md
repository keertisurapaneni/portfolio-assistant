# Technical Spec v1: Portfolio Assistant

> Personal project. 10-15 hours. Single developer. No backend beyond localStorage.

---

## Tech Stack

| Layer            | Choice                            | Why                                               |
| ---------------- | --------------------------------- | ------------------------------------------------- |
| **Framework**    | Vite + React 18                   | Fast dev server, simple setup, no SSR complexity  |
| **Language**     | TypeScript                        | Type safety, better IDE support, self-documenting |
| **Styling**      | Tailwind CSS 4                    | Utility-first, rapid UI development               |
| **Components**   | shadcn/ui                         | Beautiful, accessible, copy-paste components      |
| **Icons**        | Lucide React                      | Clean, consistent icon set                        |
| **State**        | React useState/useEffect          | Simple, no external state library needed          |
| **Storage**      | localStorage                      | No backend, data persists in browser              |
| **File Parsing** | Papa Parse (CSV), SheetJS (Excel) | Parse user-uploaded portfolio files               |
| **Stock Data**   | Finnhub API                       | Comprehensive free data, 60 calls/min             |

### Dependencies

```json
{
  "dependencies": {
    "react": "^18.x",
    "react-dom": "^18.x",
    "lucide-react": "latest",
    "clsx": "latest",
    "tailwind-merge": "latest",
    "class-variance-authority": "latest",
    "papaparse": "latest",
    "xlsx": "latest"
  },
  "devDependencies": {
    "vite": "^5.x",
    "typescript": "^5.x",
    "tailwindcss": "^4.x",
    "@tailwindcss/vite": "latest",
    "@types/node": "latest",
    "@types/papaparse": "latest"
  }
}
```

---

## Stock Data API: Finnhub

### Why Finnhub

| Aspect                | Details                                                              |
| --------------------- | -------------------------------------------------------------------- |
| **Provider**          | Finnhub.io (`https://finnhub.io/api/v1`)                             |
| **Cost**              | Free tier (60 calls/minute, no daily cap)                            |
| **Auth**              | API key required (free registration)                                 |
| **Rate Limits**       | 60 calls/minute (generous for personal use)                          |
| **Data Completeness** | Comprehensive - price, financials, analyst recommendations, profiles |
| **Docs**              | https://finnhub.io/docs/api                                          |

### Data Fetching Architecture

```typescript
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const API_KEY = import.meta.env.VITE_FINNHUB_API_KEY;

// Fetch quote, metrics, recommendations, and profile in parallel
async function getStockData(ticker: string) {
  const [quote, metrics, recommendations, profile] = await Promise.all([
    fetch(`${FINNHUB_BASE}/quote?symbol=${ticker}&token=${API_KEY}`),
    fetch(`${FINNHUB_BASE}/stock/metric?symbol=${ticker}&metric=all&token=${API_KEY}`),
    fetch(`${FINNHUB_BASE}/stock/recommendation?symbol=${ticker}&token=${API_KEY}`),
    fetch(`${FINNHUB_BASE}/stock/profile2?symbol=${ticker}&token=${API_KEY}`),
  ]);
  // ... process responses
}
```

### Data Available from Finnhub

| Data Category         | Endpoint                | Used For                              |
| --------------------- | ----------------------- | ------------------------------------- |
| **Quote & Price**     | `/quote`                | Current price, change, high/low       |
| **Company Info**      | `/stock/profile2`       | Company name, sector, market cap      |
| **Fundamentals**      | `/stock/metric`         | P/E, EPS, margins, ROE, beta, 52-week |
| **Analyst Consensus** | `/stock/recommendation` | Buy/Hold/Sell ratings count           |

### Caching Strategy

```typescript
const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_DURATION = 1000 * 60 * 15; // 15 minutes

// Cache key: ticker
// Cache invalidation: time-based or manual refresh
```

---

## Conviction Score Engine v4 (Fully Automated)

### Philosophy

> **100% data-driven. No manual inputs.**
> Score updates automatically when data is refreshed from Finnhub.
> Designed to identify strong companies AND flag weak ones.

### 4-Factor Automated Scoring Model

| Factor                | Weight | Finnhub Source            | What It Measures                              |
| --------------------- | ------ | ------------------------- | --------------------------------------------- |
| **Quality**           | 30%    | `/stock/metric`           | Profitability: EPS, margins, ROE, P/E         |
| **Earnings**          | 30%    | `/stock/metric`           | EPS growth YoY, revenue growth                |
| **Analyst Consensus** | 25%    | `/stock/recommendation`   | Wall Street Buy/Hold/Sell distribution        |
| **Momentum**          | 15%    | `/quote`, `/stock/metric` | Price change, position in 52-week range, beta |

**Total: 100% objective data**

### Factor Calculations

#### 1. Quality Score (0-100)

Measures profitability and fundamental health. **Penalizes unprofitable companies heavily.**

```typescript
function calculateQualityScore(data: Record<string, unknown>): number {
  let score = 50;

  // EPS - most important (profitable vs unprofitable)
  const eps = getYahooValue(data, 'trailingEps');
  if (eps !== null) {
    if (eps < 0)
      score -= 25; // Unprofitable = big penalty
    else if (eps > 5)
      score += 20; // Strong earnings
    else if (eps > 2) score += 15;
    else if (eps > 0.5) score += 10;
  }

  // Profit margin
  const profitMargin = getYahooValue(data, 'profitMargins');
  if (profitMargin !== null) {
    if (profitMargin < 0) score -= 20;
    else if (profitMargin > 0.2) score += 15;
    else if (profitMargin > 0.1) score += 10;
  }

  // Return on Equity
  const roe = getYahooValue(data, 'returnOnEquity');
  if (roe !== null) {
    if (roe < 0) score -= 10;
    else if (roe > 0.2) score += 15;
    else if (roe > 0.1) score += 10;
  }

  // P/E ratio sanity check
  const pe = getYahooValue(data, 'trailingPE');
  if (pe !== null) {
    if (pe < 0)
      score -= 15; // Negative P/E = unprofitable
    else if (pe > 100)
      score -= 10; // Extreme valuation
    else if (pe < 15)
      score += 10; // Reasonable valuation
    else if (pe < 25) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}
```

#### 2. Earnings Score (0-100)

Measures EPS growth trend and beat/miss pattern.

```typescript
function calculateEarningsScore(data: Record<string, unknown>): number {
  const history = data.earningsHistory?.history as unknown[] | undefined;
  if (!history || history.length < 2) return 50;

  let score = 50;
  let negativeEpsCount = 0;
  let totalGrowth = 0;

  // Analyze last 4 quarters
  const recent = history.slice(0, 4);

  recent.forEach((quarter, index) => {
    const actual = getYahooValue(quarter, 'epsActual');
    const estimate = getYahooValue(quarter, 'epsEstimate');

    // Beat/miss
    if (actual !== null && estimate !== null) {
      if (actual > estimate)
        score += 5; // Beat
      else if (actual < estimate) score -= 5; // Miss
    }

    // Negative EPS tracking
    if (actual !== null && actual < 0) {
      negativeEpsCount++;
    }

    // QoQ growth
    if (index < recent.length - 1) {
      const prev = getYahooValue(recent[index + 1], 'epsActual');
      if (actual !== null && prev !== null && prev !== 0) {
        const growth = ((actual - prev) / Math.abs(prev)) * 100;
        totalGrowth += growth;
      }
    }
  });

  // Average growth bonus/penalty
  const avgGrowth = totalGrowth / Math.max(recent.length - 1, 1);
  if (avgGrowth > 20) score += 15;
  else if (avgGrowth > 10) score += 10;
  else if (avgGrowth > 0) score += 5;
  else if (avgGrowth < -10) score -= 15;

  // Persistent losses penalty
  if (negativeEpsCount >= 3) score -= 20;
  else if (negativeEpsCount >= 2) score -= 10;

  return Math.max(0, Math.min(100, score));
}
```

#### 3. Analyst Score (0-100)

Converts Wall Street consensus into a 0-100 score.

```typescript
function calculateAnalystScore(data: Record<string, unknown>): {
  score: number;
  rating: AnalystRating | null;
} {
  const trend = data.recommendationTrend?.trend as unknown[] | undefined;
  if (!trend || trend.length === 0) return { score: 50, rating: null };

  // Get most recent period
  const recent = trend[0] as Record<string, unknown>;
  const strongBuy = (recent.strongBuy as number) || 0;
  const buy = (recent.buy as number) || 0;
  const hold = (recent.hold as number) || 0;
  const sell = (recent.sell as number) || 0;
  const strongSell = (recent.strongSell as number) || 0;

  const total = strongBuy + buy + hold + sell + strongSell;
  if (total === 0) return { score: 50, rating: null };

  // Weighted average: strongBuy=5, buy=4, hold=3, sell=2, strongSell=1
  const weightedSum = strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1;
  const avgRating = weightedSum / total; // 1-5 scale

  // Convert to 0-100 (5=100, 3=50, 1=0)
  const score = Math.round((avgRating - 1) * 25);

  // Determine rating label
  let rating: string;
  if (avgRating >= 4.5) rating = 'Strong Buy';
  else if (avgRating >= 3.5) rating = 'Buy';
  else if (avgRating >= 2.5) rating = 'Hold';
  else if (avgRating >= 1.5) rating = 'Sell';
  else rating = 'Strong Sell';

  return {
    score: Math.max(0, Math.min(100, score)),
    rating: {
      rating,
      strongBuy,
      buy,
      hold,
      sell,
      strongSell,
      targetMean: getYahooValue(data.financialData, 'targetMeanPrice') || 0,
      targetHigh: getYahooValue(data.financialData, 'targetHighPrice') || 0,
      targetLow: getYahooValue(data.financialData, 'targetLowPrice') || 0,
    },
  };
}
```

#### 4. Momentum Score (0-100)

Measures price momentum and volatility.

```typescript
function calculateMomentumScore(data: Record<string, unknown>): number {
  let score = 50;

  // Price change percentage
  const changePercent = getYahooValue(data, 'regularMarketChangePercent');
  if (changePercent !== null) {
    if (changePercent > 3) score += 10;
    else if (changePercent > 0) score += 5;
    else if (changePercent < -3) score -= 10;
    else if (changePercent < 0) score -= 5;
  }

  // Position in 52-week range
  const price = getYahooValue(data, 'regularMarketPrice');
  const high52 = getYahooValue(data, 'fiftyTwoWeekHigh');
  const low52 = getYahooValue(data, 'fiftyTwoWeekLow');

  if (price !== null && high52 !== null && low52 !== null && high52 !== low52) {
    const rangePosition = (price - low52) / (high52 - low52);
    if (rangePosition > 0.8)
      score += 15; // Near highs
    else if (rangePosition > 0.5) score += 10;
    else if (rangePosition < 0.2) score -= 10; // Near lows
  }

  // Beta adjustment (lower volatility preferred)
  const beta = getYahooValue(data, 'beta');
  if (beta !== null) {
    if (beta < 0.8)
      score += 5; // Low volatility
    else if (beta > 1.5) score -= 5; // High volatility
  }

  return Math.max(0, Math.min(100, score));
}
```

### Combined Conviction Score

```typescript
const WEIGHTS = {
  quality: 0.3,
  earnings: 0.3,
  analyst: 0.25,
  momentum: 0.15,
};

// THRESHOLDS
const RED_FLAG_THRESHOLD = 25;
const SELL_THRESHOLD = 35;
const BUY_THRESHOLD = 60;

function calculateConviction(inputs: ScoreInputs): number {
  // Check for RED FLAGS
  const hasQualityRedFlag = inputs.qualityScore < RED_FLAG_THRESHOLD;
  const hasEarningsRedFlag = inputs.earningsScore < RED_FLAG_THRESHOLD;
  const hasCriticalRedFlag = hasQualityRedFlag && hasEarningsRedFlag;
  const hasAnyRedFlag = hasQualityRedFlag || hasEarningsRedFlag;

  // Check if Wall Street strongly disagrees (turnaround potential)
  const analystBullish = inputs.analystScore >= 65; // Buy or better
  const analystStrongBuy = inputs.analystScore >= 75;

  // Calculate raw score
  let raw =
    inputs.qualityScore * WEIGHTS.quality +
    inputs.momentumScore * WEIGHTS.momentum +
    inputs.earningsScore * WEIGHTS.earnings +
    inputs.analystScore * WEIGHTS.analyst;

  // Apply RED FLAG adjustments - BUT respect strong analyst disagreement
  if (hasCriticalRedFlag) {
    if (analystStrongBuy) {
      // Wall Street strongly bullish despite poor fundamentals → turnaround play
      raw = Math.max(raw, 40); // Floor at Hold territory
    } else if (analystBullish) {
      // Analysts see something → softer penalty
      raw = Math.min(raw, 42);
    } else {
      raw = Math.min(raw, 30);
    }
  } else if (hasAnyRedFlag) {
    if (analystBullish) {
      raw = Math.min(raw, 50); // Respect analyst view
    } else {
      raw = Math.min(raw, 45);
    }
  }

  // Extra penalty for severely impaired quality (but not if analysts see value)
  if (inputs.qualityScore < 15 && !analystBullish) {
    raw -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(raw)));
}
```

### Turnaround Play Logic (v2 - Fixed)

When analysts strongly disagree with poor fundamentals, they may see a turnaround story. The system respects this by **flooring** the score (using `Math.max`) rather than capping it:

1. **Strong Buy consensus (≥75) + Critical red flags** → Score floors at 42 (`Math.max(raw, 42)`) - ensures at least "Hold"
2. **Buy consensus (≥65) + Critical red flags** → Score floors at 38 (`Math.max(raw, 38)`) - keeps in Hold territory
3. **Buy consensus (≥65) + Any red flag** → Score floors at 40 (`Math.max(raw, 40)`) - respects analyst view
4. **No analyst support + Critical red flags** → Score capped at 30 (Sell)

**Key Fix:** Using `Math.max` instead of `Math.min` ensures that when analysts are bullish on a fundamentally weak company, the score is _raised_ to Hold territory rather than further lowered. This properly reflects the "turnaround play" thesis.

This prevents the system from being overly punitive when Wall Street (like Zacks) sees recovery potential.

### Posture Logic

```typescript
function getPosture(score: number): Posture {
  if (score >= 65) return 'Buy';
  if (score <= 35) return 'Sell';
  return 'Hold';
}
```

### Confidence Derivation (v2 - Refined)

Confidence = signal alignment + analyst confirmation + distance from thresholds.

**Key insight:** Turnaround plays (weak fundamentals + bullish analysts) always get "Low" confidence because the signals are conflicting. "High" confidence requires strong consensus across factors.

```typescript
function getConfidence(inputs: ScoreInputs, finalScore: number): Confidence {
  const allScores = [
    inputs.qualityScore,
    inputs.momentumScore,
    inputs.earningsScore,
    inputs.analystScore,
  ];

  // Calculate agreement (standard deviation)
  const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const variance = allScores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / allScores.length;
  const stdDev = Math.sqrt(variance);

  // Count factors by strength
  const strong = allScores.filter(s => s >= 60).length; // Good (Buy territory)
  const weak = allScores.filter(s => s <= 40).length; // Concerning
  const mixed = strong > 0 && weak > 0; // Conflicting signals

  // Turnaround detection (conflicting signals)
  const fundamentalsWeak = inputs.qualityScore < 30 || inputs.earningsScore < 30;
  const analystBullish = inputs.analystScore >= 65;
  const turnaroundPlay = fundamentalsWeak && analystBullish;

  // Distance from thresholds
  const distFromBuy = Math.abs(finalScore - 60);
  const distFromSell = Math.abs(finalScore - 35);
  const minDistance = Math.min(distFromBuy, distFromSell);

  // LOW confidence: mixed signals, turnaround plays, or near thresholds
  if (mixed || minDistance < 8 || stdDev > 22 || turnaroundPlay) {
    return 'Low';
  }

  // HIGH confidence: score >= 72 AND 3+ factors strong AND analyst bullish AND no weak factors
  const analystBullishForHigh = inputs.analystScore >= 65;
  const strongBuySignal = finalScore >= 72 && strong >= 3 && analystBullishForHigh && weak === 0;
  const strongSellSignal = finalScore <= 30 && allScores.filter(s => s <= 25).length >= 3;

  if (strongBuySignal || strongSellSignal) {
    return 'High';
  }

  // Default: MEDIUM (most common case)
  return 'Medium';
}
```

**High Confidence Requirements:**

- Overall score >= 72
- At least 3 of 4 factors >= 60 (strong)
- Analyst score >= 65 (Wall Street bullish)
- No factors <= 40 (no red flags)

**Low Confidence Triggers:**

- Mixed signals (some strong, some weak factors)
- Near Buy/Sell threshold (< 8 points)
- High disagreement between factors (stdDev > 22)
- Turnaround play (weak fundamentals but bullish analysts)

### Rationale Generation

```typescript
function generateRationale(inputs: ScoreInputs): string[] {
  const rationale: string[] = [];

  // Quality assessment
  if (inputs.qualityScore >= 70) {
    rationale.push('Strong profitability metrics');
  } else if (inputs.qualityScore < 30) {
    rationale.push('⚠️ Weak profitability (negative/low margins)');
  }

  // Earnings assessment
  if (inputs.earningsScore >= 70) {
    rationale.push('EPS growing consistently');
  } else if (inputs.earningsScore < 30) {
    rationale.push('⚠️ EPS declining or persistently negative');
  }

  // Analyst assessment
  if (inputs.analystScore >= 70) {
    rationale.push('Strong analyst consensus (Buy ratings)');
  } else if (inputs.analystScore < 30) {
    rationale.push('Weak analyst consensus (Sell ratings)');
  }

  // Momentum assessment
  if (inputs.momentumScore >= 70) {
    rationale.push('Strong price momentum');
  } else if (inputs.momentumScore < 30) {
    rationale.push('Weak price momentum');
  }

  // Red flag summary
  if (inputs.qualityScore < 25 && inputs.earningsScore < 20) {
    rationale.unshift('🚨 RED FLAG: Both quality and earnings critically weak');
  }

  return rationale.slice(0, 3); // Max 3 bullets
}
```

---

## Data Models

```typescript
// === Stock ===
interface Stock {
  ticker: string;
  name: string;
  dateAdded: string;

  // Position data (optional, from CSV import)
  shares?: number;
  avgCost?: number;

  // Live data from Yahoo Finance
  currentPrice?: number;

  // Cached scores (refreshed on demand)
  qualityScore?: number;
  momentumScore?: number;
  earningsScore?: number;
  analystScore?: number;

  // Analyst rating details
  analystRating?: AnalystRating;

  // Quarterly EPS data
  quarterlyEPS?: QuarterlyEPS[];
}

// === Quarterly EPS ===
interface QuarterlyEPS {
  date: string;
  period: string;
  fiscalYear: string;
  eps: number;
  revenue: number;
}

// === Analyst Rating ===
interface AnalystRating {
  rating: string; // 'Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  targetMean: number;
  targetHigh: number;
  targetLow: number;
}

// === Score Inputs (all automated) ===
interface ScoreInputs {
  qualityScore: number;
  momentumScore: number;
  earningsScore: number;
  analystScore: number;
}

// === Conviction Result ===
interface ConvictionResult {
  score: number;
  posture: 'Buy' | 'Hold' | 'Sell';
  confidence: 'High' | 'Medium' | 'Low';
  rationale: string[];
}

// === Stock with UI data ===
interface StockWithConviction extends Stock {
  conviction: ConvictionResult;
  previousScore?: number;
  positionValue?: number;
  portfolioWeight?: number;
}
```

---

## Risk Warning System

### Warning Types

| Warning Type               | Trigger                     | Severity | Purpose                   |
| -------------------------- | --------------------------- | -------- | ------------------------- |
| **Concentration**          | Position > 15% of portfolio | Warning  | Reduce single-stock risk  |
| **Critical Concentration** | Position > 25% of portfolio | Critical | Urgent rebalancing needed |
| **Loss Alert**             | Down > 8% from cost basis   | Warning  | Review thesis validity    |
| **Critical Loss**          | Down > 15% from cost basis  | Critical | Reassess investment case  |
| **Gain Alert**             | Up > 25% from cost basis    | Info     | Consider profit-taking    |

### Warning Interface

```typescript
interface Warning {
  type: 'concentration' | 'loss' | 'gain' | 'rebalance';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  action: string;
}
```

---

## UI Components

| Component              | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `Dashboard`            | Main portfolio view with sorted cards      |
| `StockCard`            | Summary card showing posture, score, delta |
| `StockDetail`          | Slide-over with full breakdown + tooltips  |
| `SuggestedFinds`       | Discovery engine with expandable rows      |
| `AddTickersModal`      | Add stocks by ticker                       |
| `ImportPortfolioModal` | CSV/Excel import                           |

### Confidence Visual Styling

The posture badge visually indicates confidence level:

| Confidence | Visual Treatment                             |
| ---------- | -------------------------------------------- |
| **High**   | Colored ring around pill (emerald/amber/red) |
| **Medium** | Normal solid border (default)                |
| **Low**    | Dashed border (indicates uncertainty)        |

```tsx
// StockCard posture pill styling
<span className={cn(
  'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold border',
  posture.bg, posture.text, posture.border,
  // High = ring highlight
  confidence === 'High' && 'ring-2 ring-offset-1',
  confidence === 'High' && posture === 'Buy' && 'ring-emerald-400',
  confidence === 'High' && posture === 'Hold' && 'ring-amber-400',
  confidence === 'High' && posture === 'Sell' && 'ring-red-400',
  // Low = dashed border
  confidence === 'Low' && 'border-dashed'
)}>
```

### Suggested Finds Layout (v2)

Redesigned for scannability:

| Element            | Description                                          |
| ------------------ | ---------------------------------------------------- |
| **Row layout**     | Two-line rows (ticker + description)                 |
| **Always visible** | Stock ticker, Yahoo link, company description        |
| **On expand**      | Detailed metrics as clean pill badges                |
| **Metric colors**  | Consistent by type (ROIC=emerald, Margin=blue, etc.) |

### Score Explanation Tooltips

Each factor score in StockDetail has an info icon with tooltip explaining the calculation:

- **Quality**: "Based on EPS, profit margins, operating margin, ROE, and P/E ratio"
- **Earnings**: "Based on quarterly EPS trend, beat/miss history, and growth rate"
- **Analyst**: "Wall Street consensus converted to 0-100 score"
- **Momentum**: "Based on 52-week range position, daily change, and beta"

---

## Explicit Non-Goals (v1)

| Non-Goal                   | Reason                                    |
| -------------------------- | ----------------------------------------- |
| News → Action Engine       | Requires NLP/LLM + news API; marked as v2 |
| Manual thesis input        | Removed for simplicity; fully automated   |
| Complex API key management | Single Finnhub key in .env is sufficient  |
| Social media sentiment     | No free API; would need scraping          |
| Real-time streaming prices | On-demand refresh is sufficient           |
| Multiple portfolios        | One portfolio per browser is enough       |
| User authentication        | localStorage per browser is sufficient    |
| Push notifications         | Users check manually                      |

---

## Feature Status

### MVP (v1) - Complete

- [x] Conviction Dashboard
- [x] 4-Factor Automated Scoring (Quality, Earnings, Analyst, Momentum)
- [x] Portfolio Import (CSV/Excel)
- [x] Yahoo Finance links (each ticker links to Yahoo Finance)
- [x] Risk Warning System (concentration, loss, gain alerts)
- [x] Wall Street Analyst Consensus display
- [x] Current Price Tracking
- [x] EPS History display
- [x] Clear Portfolio functionality
- [x] Score explanation tooltips (info icons with calculation details)
- [x] Confidence visual distinction (ring for High, dashed for Low)
- [x] Turnaround play logic (respects analyst bullishness on weak fundamentals)
- [x] Suggested Finds - Quiet Compounders section
- [x] Suggested Finds - Gold Mines section (AI/Infrastructure theme)
- [x] Suggested Finds - Expandable rows with metric pills
- [x] Footer disclaimer ("Score is 100% data-driven...")

### Future (v2)

- [ ] **AI-Powered Gold Mine Discovery** - Use LLM to analyze market news and identify emerging investment themes dynamically
- [ ] News → Portfolio Action Engine
- [ ] Historical conviction score tracking
- [ ] Mobile-responsive design

---

## v2 Feature Spec: AI-Powered Gold Mine Discovery

### Overview

Automatically identify investable macro themes from current market news using AI/LLM analysis.

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   News API      │────▶│   LLM Analysis  │────▶│  Stock Screen   │
│ (Finnhub/News)  │     │ (OpenAI/Claude) │     │   (Finnhub)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
   Recent headlines      Theme extraction        Matching stocks
   Market trends         Value chain map         with fundamentals
```

### Data Flow

1. **Fetch News** - Daily/weekly market news from Finnhub News API
2. **LLM Analysis** - Extract macro themes and value chain segments
3. **Stock Screening** - Find stocks matching themes with strong fundamentals
4. **Display** - Dynamic "Gold Mines" section with AI-generated themes

### LLM Prompt Template

```
Based on these recent market news headlines:
{headlines}

Identify 1-2 investable macro themes currently emerging. For each theme:
1. Theme name (e.g., "AI Infrastructure Build-Out")
2. Brief description (2-3 sentences)
3. Value chain segments:
   - Infrastructure suppliers
   - Second-order beneficiaries
   - Enablers
4. Example tickers for each segment (2-3 per segment)

Output as JSON.
```

### API Requirements

| Service      | Endpoint                          | Cost                |
| ------------ | --------------------------------- | ------------------- |
| Finnhub News | `/company-news` or `/market-news` | Free tier           |
| OpenAI       | `gpt-4o-mini`                     | ~$0.01 per analysis |
| Claude       | `claude-3-haiku`                  | ~$0.01 per analysis |

### Implementation Estimate

- News fetching + caching: 1-2 hours
- LLM integration: 2-3 hours
- UI updates: 1 hour
- **Total: 4-6 hours**

---

_Spec updated to reflect Finnhub integration and 4-factor automated scoring model._
