---
stepsCompleted: [1]
inputDocuments:
  - planning-artifacts/product-brief-portfolio-assistant-2026-02-04.md
  - planning-artifacts/technical_spec_v1.md
  - planning-artifacts/brainstorm/problem_frame.md
date: 2026-02-04
author: keerti
project_name: portfolio-assistant
---

# UX Design Specification: Portfolio Assistant

**Author:** keerti
**Date:** 2026-02-04

---

## Design Principles

### Visual / UI Preferences (From Stakeholder)

| Principle                    | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| **Clean, modern, minimal**   | No visual clutter. Every element earns its space.                   |
| **Neutral palette**          | Calm, professional base colors. Not distracting.                    |
| **Meaningful color only**    | Green/red used sparingly — only when it adds signal, not decoration |
| **At-a-glance + drill-down** | Clear indicators visible immediately; detail available on demand    |
| **Card-based layouts**       | Prefer cards over dense tables. Scannable, not spreadsheet-y.       |

### Design Philosophy

> This is a tool you open with morning coffee. It should feel **calm and confident**, not anxious and overwhelming. The UI should answer "do I need to do anything today?" in 3 seconds.

### Core UX Question

> **The main dashboard should always answer:**
> _"What do I believe right now, and has that belief changed?"_

---

## Information Architecture

### Page/Tab Structure

| View                          | Purpose                                 | Access Method          |
| ----------------------------- | --------------------------------------- | ---------------------- |
| **My Portfolio** (tab)        | Conviction overview for all holdings    | Default tab            |
| **Suggested Finds** (tab)     | Curated stock ideas to explore          | Second tab             |
| **Stock Detail** (slide-over) | Thesis + earnings + score breakdown     | Click any stock row    |
| **Add Tickers** (modal)       | Manual ticker entry OR CSV/Excel import | Button in header       |
| **Import Portfolio** (modal)  | Upload file + column mapping            | Tab in Add Tickers     |
| **Add Earnings** (modal)      | Log new earnings outcome                | Button in stock detail |

### Navigation Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Portfolio Assistant                                        │
│  [ My Portfolio ]   [ Suggested Finds ]      [+ Add Tickers]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  (Tab content)                                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Screen Specifications

### 1. My Portfolio (Default Tab)

**Purpose:** At-a-glance conviction status for all holdings.

**Layout:** Card-table hybrid — each stock as a scannable row-card.

```
┌─────────────────────────────────────────────────────────────┐
│  MY PORTFOLIO                                    [Sort ▼]   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐   │
│  │ AAPL   15%  │ 🟢 Buy (High)  │ 78/100 │ ↑ +5  │ ••• │   │
│  │ Apple Inc   │ Strong quality, positive momentum      │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ MSFT   12%  │ 🟡 Hold (Med)  │ 54/100 │ →  0  │ ••• │   │
│  │ Microsoft   │ Mixed signals, thesis intact           │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ NVDA    8%  │ 🔴 Sell (Low)  │ 32/100 │ ↓ -12 │ ••• │   │
│  │ NVIDIA      │ Thesis weakening, earnings miss        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Row Elements:**
| Element | Description |
|---------|-------------|
| Ticker + Name | Stock identifier |
| Portfolio Weight | % of total portfolio (if position data available) |
| Posture badge | Buy / Hold / Sell with confidence (High/Med/Low) |
| Score | Conviction score (0-100) |
| Delta | Change since last update (↑/↓/→) |
| Rationale | 1-line summary of why |

**Interaction:** Click row → Opens Stock Detail slide-over

---

### 2. Stock Detail (Slide-over Panel) - v2 with Tooltips

**Purpose:** Full context for a single stock — score breakdown with explanations, earnings history.

```
┌─────────────────────────────────────────────────────────────┐
│  AAPL — Apple Inc                              [Close X]    │
├─────────────────────────────────────────────────────────────┤
│  POSTURE: 🟢 Buy (High confidence)              78/100      │
│                                                             │
│  ┌─ SCORE BREAKDOWN ──────────────────────────────────────┐ │
│  │ Quality     ████████░░  82  ⓘ                          │ │
│  │ Earnings    █████████░  88  ⓘ                          │ │
│  │ Analyst     ███████░░░  71  ⓘ                          │ │
│  │ Momentum    ██████░░░░  65  ⓘ                          │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ WALL STREET CONSENSUS ────────────────────────────────┐ │
│  │ Strong Buy: 12  Buy: 24  Hold: 8  Sell: 1              │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ EARNINGS HISTORY (from Finnhub) ─────────────────────┐  │
│  │ Q4 2025 │ EPS: $2.14 │ Est: $2.08 │ ✅ Beat           │  │
│  │ Q3 2025 │ EPS: $1.96 │ Est: $1.90 │ ✅ Beat           │  │
│  │ Q2 2025 │ EPS: $1.52 │ Est: $1.52 │ ➖ Inline         │  │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  Score is 100% data-driven from Finnhub. Conviction         │
│  reflects cumulative signals, not a price prediction.       │
└─────────────────────────────────────────────────────────────┘
```

**v2 Enhancements:**

| Element               | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| **Info icons (ⓘ)**    | Hover/click to see calculation explanation for each factor   |
| **ScoreBar colors**   | Green >= 60, Amber >= 35, Red < 35 (aligned with thresholds) |
| **Footer disclaimer** | Always visible at bottom of detail panel                     |

**Tooltip Explanations:**

- **Quality ⓘ** → "Based on EPS, profit margins, operating margin, ROE, and P/E ratio"
- **Earnings ⓘ** → "Based on quarterly EPS trend, beat/miss history, and growth rate"
- **Analyst ⓘ** → "Wall Street consensus converted to 0-100 score"
- **Momentum ⓘ** → "Based on 52-week range position, daily change, and beta"

---

### 3. Suggested Finds (Second Tab) - v2 Layout

**Purpose:** Surface curated stock ideas tagged by archetype with expandable details.

**Layout:** Two-line rows with description always visible, metrics on expand.

```
┌─────────────────────────────────────────────────────────────┐
│  SUGGESTED FINDS                                [Refresh]   │
├─────────────────────────────────────────────────────────────┤
│  🏔️ QUIET COMPOUNDERS                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ODFL 🔗  Old Dominion Freight Line    [▶] [+ Add]    │   │
│  │ Boring trucking, 20% ROIC, low volatility            │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ COST 🔗  Costco Wholesale              [▶] [+ Add]    │   │
│  │ Membership model, consistent compounder              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  💎 GOLD MINES (AI Infrastructure Theme)                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ NVDA 🔗  NVIDIA Corp                   [▶] [+ Add]    │   │
│  │ AI compute infrastructure leader                     │   │
│  │ (Expanded) ┌────────────────────────────────────┐    │   │
│  │            │ ROIC 45%  Margin 62%  CAGR +38%    │    │   │
│  │            └────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Row Elements (v2):**

| Element           | Description                               |
| ----------------- | ----------------------------------------- |
| **Ticker**        | Stock symbol with Yahoo Finance link (🔗) |
| **Company Name**  | Full company name                         |
| **Description**   | Always visible - why this stock fits      |
| **Expand toggle** | [▶] to show/hide metrics                  |
| **Add button**    | [+ Add] to add to portfolio               |

**Expanded State:**

| Element          | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| **Metric pills** | ROIC, Margin, CAGR as clean colored badges                           |
| **Color coding** | Consistent by metric type (ROIC=emerald, Margin=blue, Growth=violet) |

**Design Change (v2):** Moved from card grid to two-line rows for better scannability. Description always visible without expanding. Metrics revealed on demand as clean pills.

---

### 4. Add Tickers (Modal with Tabs)

**Purpose:** Add stocks to portfolio via manual entry OR file import.

```
┌─────────────────────────────────────────────────────────────┐
│  ADD TO PORTFOLIO                              [Close X]    │
│  [ Manual Entry ]  [ Import File ]                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ── MANUAL ENTRY TAB ──                                     │
│                                                             │
│  Enter tickers (comma-separated):                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ AAPL, MSFT, GOOG, AMZN                              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│                              [Cancel]  [Add to Portfolio]   │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│  ADD TO PORTFOLIO                              [Close X]    │
│  [ Manual Entry ]  [ Import File ]                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ── IMPORT FILE TAB ──                                      │
│                                                             │
│  Upload CSV or Excel from your brokerage:                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         📁 Drop file here or click to browse        │    │
│  │              Supports .csv, .xlsx                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  We'll auto-detect: Ticker, Shares, Avg Cost, Name         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4b. Column Mapper (Sub-modal, if auto-detect fails)

**Purpose:** Manual column mapping fallback.

```
┌─────────────────────────────────────────────────────────────┐
│  MAP COLUMNS                                   [Close X]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Your file has these columns:                               │
│  [A: Symbol] [B: Description] [C: Qty] [D: Price] [E: ...]  │
│                                                             │
│  Ticker (required):    [ A: Symbol        ▼ ]               │
│  Shares (optional):    [ C: Qty           ▼ ]               │
│  Avg Cost (optional):  [ D: Price         ▼ ]               │
│  Name (optional):      [ B: Description   ▼ ]               │
│                                                             │
│  Preview: 12 stocks found                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ AAPL  │  150 shares  │  $142.50 avg  │  Apple Inc  │    │
│  │ MSFT  │   75 shares  │  $285.00 avg  │  Microsoft  │    │
│  │ ...                                                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│                              [Cancel]  [Import 12 stocks]   │
└─────────────────────────────────────────────────────────────┘
```

---

### 5. Add Earnings (Modal)

**Purpose:** Log a new earnings outcome for a stock.

```
┌─────────────────────────────────────────────────────────────┐
│  ADD EARNINGS — AAPL                           [Close X]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Quarter:   [ Q1 2026 ▼ ]                                   │
│                                                             │
│  Outcome:   ( ) Beat   ( ) Inline   ( ) Miss                │
│                                                             │
│  Follow-through:  ( ) Positive  ( ) Neutral  ( ) Negative   │
│                                                             │
│  Notes (optional):                                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Services revenue surprised, iPhone flat            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│                                    [Cancel]  [Save]         │
└─────────────────────────────────────────────────────────────┘
```

---

## Color System

| Usage              | Color        | When                     |
| ------------------ | ------------ | ------------------------ |
| **Buy**            | Green        | Posture = Buy            |
| **Hold**           | Yellow/Amber | Posture = Hold           |
| **Sell**           | Red          | Posture = Sell           |
| **Neutral**        | Gray         | Default state, no signal |
| **Positive delta** | Green        | Score increased          |
| **Negative delta** | Red          | Score decreased          |

**Rule:** Color only when it adds signal. Default to neutral palette.

### Confidence Visual Styling (v2)

The posture badge includes visual indicators for confidence level:

| Confidence | Visual Treatment                           |
| ---------- | ------------------------------------------ |
| **High**   | Colored ring around pill (matches posture) |
| **Medium** | Normal solid border (default appearance)   |
| **Low**    | Dashed border (indicates uncertainty)      |

**Examples:**

- `🟢 Buy (High)` → Green pill with green ring highlight
- `🟡 Hold (Med)` → Amber pill with solid border
- `🔴 Sell (Low)` → Red pill with dashed border

---

## Responsive Behavior

| Breakpoint        | Behavior                                      |
| ----------------- | --------------------------------------------- |
| Desktop (1024px+) | Side-by-side layout, slide-over panels        |
| Tablet (768px)    | Stacked cards, slide-over as overlay          |
| Mobile (< 768px)  | Full-screen detail view instead of slide-over |

---

## Summary

**Portfolio Assistant** is a 2-tab application:

1. **My Portfolio** — conviction dashboard answering "what do I believe?"
2. **Suggested Finds** — curated ideas to explore

Detail views appear as slide-overs, keeping context. Modals handle data entry (add tickers, log earnings).

The UI is calm, minimal, and decisive — designed to reduce anxiety, not create it.
