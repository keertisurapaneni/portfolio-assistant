# Dip Discovery — Suggested Finds Category

**Date:** 2026-05-05
**Status:** Shipped

## Goal

Add a "Dip Discovery" category to Suggested Finds that buys quality blue-chip stocks (S&P 500 / Fortune 500) when they've dropped 30-50% from their 52-week high and show signs of stabilization. This targets mean-reversion on proven companies at deep discounts.

## Why

Current Suggested Finds BUYs (Compounders + Gold Mines) have 0-19% win rates — they pick "good companies" at whatever price. Dip Discovery flips the model: buy *known* quality at a *proven discount*. The system's SELL signals (100% WR) prove it can time reversals; Dip Discovery is the mirror image.

## Entry Criteria

- **Universe:** S&P 500 member, market cap > $10B, trailing 12-month EPS > 0, avg daily volume > $50M notional
- **Drawdown:** -30% to -50% from 52-week high
- **Stabilization:** Price above 10-day SMA (confirms bleeding has stopped)
- **Timeframe:** Drop occurred within 4-16 weeks (sharp drawdown, not slow bleed)
- **Catalyst check:** AI reviews *why* it dipped — skip if structural (fraud, secular disruption, junk downgrade); buy if temporary (earnings miss with intact guidance, sector rotation, macro selloff)

## Position Sizing

- Standard: $3,000-$5,000
- Max 3 concurrent Dip Discovery positions
- Max 1 per GICS sector

## Exit Rules

- **Take-profit:** 40% recovery of the drawdown (e.g., drops from $100 → $60, TP at $76)
- **Stop-loss:** -15% from entry price
- **Max hold:** 120 calendar days
- Risk/reward: risking ~$450-750 to make ~$480-800 per trade

## Architecture (per Winston)

- New tag `"Dip Discovery"` flows through existing `executeSuggestedFindTrade()` pipeline
- Own allocation bucket (separate from Compounders and Gold Mines)
- Exit rules parameterized per category in the long-term auto-sell loop
- Universe filter + drawdown calculation is the new scanner logic

## Key Decisions

- 30-50% drawdown range (user preference — more conservative than the 15-35% institutional default)
- Sits alongside existing categories, not replacing them
- AI catalyst check distinguishes "overreaction" from "broken company"

## Files Changed

| File | What |
|---|---|
| `auto-trader/src/lib/discovery.ts` | New `discoverDipStocks()` pipeline: AI candidates → Finnhub drawdown verify → SMA stabilization → AI catalyst check |
| `auto-trader/src/lib/supabase.ts` | `getLongTermExposureByTag()` tracks Dip Discovery exposure, count, and sector set |
| `auto-trader/src/scheduler.ts` | Dip Discovery integration: fetching, position sizing ($5K cap), allocation gates (max 3, max 1/sector), custom exit rules (40% recovery TP, -15% SL, 120-day max hold) |
| `supabase/functions/huggingface-proxy/index.ts` | Added `discover_dips` to valid prompt types |
| `app/src/types/index.ts` | `SuggestedStock.tag` includes `'Dip Discovery'` |
| `app/src/lib/aiSuggestedFinds.ts` | `DiscoveryResult.dipDiscoveries` field |
| `app/src/hooks/useSuggestedFinds.ts` | Exposes `dipDiscoveries` state from hook |
| `app/src/components/SuggestedFinds.tsx` | Dip Discovery section (top of page) with `DipDiscoveryCard` showing drawdown, sector, 52w high |
