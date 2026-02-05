# AI Buy Priority System

## Overview

The Portfolio Assistant uses a **data-aware recommendation system** that adjusts its confidence based on the completeness of your portfolio data.

## 🎯 Priority Levels

### 🎯 BUY NOW (Green)
**When:** Strong fundamentals + momentum, position <15% of portfolio
**Action:** High-conviction entry point, consider immediate purchase

### 📈 ACCUMULATE (Blue)
**When:** Good fundamentals but weak momentum, OR position 15-25%
**Action:** Dollar-cost average, add gradually over time

### 💼 HOLD (Yellow)
**When:** Position >25% of portfolio
**Action:** Focus new capital elsewhere to reduce concentration risk

### ⏸️ WAIT (Gray)
**When:** Weak fundamentals or poor momentum
**Action:** Monitor, wait for improvement before buying

---

## 📊 Data Completeness Levels

### ✅ FULL (Best Recommendations)
**Requires:**
- Number of shares owned
- Average cost/purchase price
- Current market data (auto-fetched)

**What you get:**
- Position-aware recommendations
- Concentration risk alerts
- Specific buy/sell sizing guidance
- No asterisks or warnings

### ⚠️ SCORES_ONLY (Limited Recommendations)
**When:**
- Missing shares data OR average cost
- Only market scores available

**What you get:**
- Generic recommendations (ACCUMULATE/WAIT)
- No position sizing guidance
- Badge shows asterisk (*)
- Warning: "Add position data for better recommendations"

### ❌ MINIMAL (Weakest Recommendations)
**When:**
- Missing both shares AND average cost
- Very limited data

**What you get:**
- Basic guidance only
- Strong suggestion to import data

---

## 🔧 How to Get Better Recommendations

### Step 1: Import Your Portfolio Data
1. Click **"Import Portfolio"** (📥 button)
2. Upload CSV/Excel with these columns:
   - **Ticker** (required): Stock symbol
   - **Shares** (recommended): Number of shares you own
   - **Average Cost** (recommended): Your purchase price per share
   - Name (optional): Company name

### Step 2: Why Each Field Matters

**Ticker (Required)**
- Identifies the stock to analyze
- Enables real-time data fetching

**Shares (Critical for Priority)**
- Calculates position value
- Determines portfolio weight (%)
- Enables concentration alerts
- **Without this:** You'll see generic "ACCUMULATE" recommendations

**Average Cost (Helpful)**
- More accurate position value
- Enables gain/loss tracking
- Falls back to current price if missing

### Step 3: Example CSV Format

```csv
Ticker,Name,Shares,Average Cost
META,Meta Platforms,500,280.50
SNOW,Snowflake,1000,150.25
GOOGL,Alphabet,300,140.75
```

---

## 🧠 Decision Logic

### With Full Data:
```
IF (Strong fundamentals + momentum) AND (Position < 15%)
  → BUY NOW 🎯

ELSE IF (Position 15-25%)
  → ACCUMULATE 📈 (slow down, diversify)

ELSE IF (Position > 25%)
  → HOLD 💼 (concentration risk!)

ELSE IF (Weak fundamentals)
  → WAIT ⏸️
```

### Without Position Data:
```
IF (Strong scores)
  → ACCUMULATE 📈 (add shares/cost for better advice)

ELSE IF (Weak scores)
  → WAIT ⏸️

ELSE
  → ACCUMULATE 📈 (import data!)
```

---

## 💡 Pro Tips

1. **Starred badges (*)** = Limited recommendation, import data to improve
2. **Dashed borders** = Missing position data
3. **Click any stock** = See detailed explanation of what's missing
4. **Update regularly** = Re-import when you buy/sell to keep recommendations accurate

---

## 🎨 Visual Indicators

### Main Page (Stock Cards)
- **Solid badge, no asterisk** → Full data, confident recommendation
- **Dashed badge with asterisk (*)** → Limited data, generic recommendation
- **Hover tooltip** → Explains data status

### Detail View
- **Purple section** → AI Buy Priority with reasoning
- **Amber warning box** → Missing data alert with improvement suggestions
- **"Cached" badge** → Using stored recommendation (24hr)

---

## 🚀 Getting Started

**First Time Users:**
1. Add some tickers manually to see how it works
2. Notice the generic recommendations with asterisks
3. Import your portfolio CSV
4. Watch recommendations become specific and actionable!

**Existing Users:**
If you're seeing "ACCUMULATE" for everything:
1. Click any stock → See what data is missing
2. Export your portfolio from broker as CSV
3. Import it → Recommendations will adjust immediately

---

## ❓ FAQ

**Q: Why am I seeing ACCUMULATE for all stocks?**
A: You likely don't have position data. The system can't determine if you already own 30% of that stock, so it defaults to conservative advice.

**Q: I have shares but not average cost, will it work?**
A: Yes! It will use current price to estimate position value. It's less accurate for gain/loss but still enables position-aware recommendations.

**Q: Can I use this without importing data?**
A: Yes, but recommendations will be generic. You'll see conviction scores based on fundamentals, but no position-specific buy/sell guidance.

**Q: How often should I re-import?**
A: After any significant trades. The position % drives recommendations, so keep it updated.

---

## 🔮 Future Enhancements

Ideas we're considering:
- Auto-sync with brokers (Robinhood, Fidelity, etc.)
- Portfolio rebalancing suggestions
- Tax-loss harvesting recommendations
- Sector exposure analysis
- Risk-adjusted position sizing

Got ideas? Let us know!
