# Advanced Options Strategy + Morning Brief — Session Notes

**Date:** April 24, 2026  
**Session type:** Implementation sprint — multiple video-driven strategy enhancements

---

## Goal

Implement a set of confirmed strategies from three independent put-selling videos, plus build an AI-powered pre-market research dashboard. All changes go to the paper trading account (IB DUP876374).

---

## Key Decisions

### 1. VIX-Tiered Delta System
**Problem:** Binary bear/bull delta (0.15 vs 0.30) doesn't capture the nuance of market panic.  
**Insight (from 2 videos independently):** When VIX spikes above 30 AND a quality stock touches its 200-day moving average, that is the *maximum aggression* moment — IV is inflated (collect more premium) and the 200 DMA is a documented institutional buying zone (the stock will recover).  
**Decision:** Implement 3-tier delta system based on VIX level + per-stock 200 DMA proximity.

| Condition | STABLE | GROWTH | HIGH VOL |
|-----------|--------|--------|----------|
| VIX > 30 + near 200 DMA | 0.35 | 0.35 | 0.20 |
| VIX 25-30 or bear mode | 0.20 | 0.15 | 0.15 |
| Normal | tier default | tier default | tier default |

**Trade-off considered:** More aggressive delta means higher assignment risk. Accepted because (a) we *want* to own quality names at 200 DMA prices, (b) HIGH_VOL stays at 0.20 regardless, (c) daily position cap (3/day) limits over-deployment.

### 2. Full-Day Scan Schedule
**Problem:** Scanner only ran 10:00–11:30 AM, missing afternoon dislocations.  
**Insight (husband's observation, validated analytically):** The VIX-spike + 200 DMA signal we just built can trigger at 2 PM as easily as at 10 AM.  
**Decision:** Expand to morning (15 min) + midday (30 min) + afternoon (30 min) with a 3-position daily cap.  
**Trade-off:** More Finnhub API calls. Mitigated by 30-min cadence in non-morning sessions.

### 3. Put Rolling at 21 DTE
**Problem:** Hard-closing at 21 DTE often crystallized recoverable losses.  
**Insight (rolling video):** Roll down-and-out for a credit first; only close if no good roll exists.  
**Decision:** `evaluateAndRollPut()` — looks 4-6 weeks out at 5-10% lower strike; requires net credit ≥ $0. Also added early roll when stock threatens strike before 21 DTE.  
**Tracking added:** `roll_count` and `rolled_from_id` columns on `paper_trades`.

### 4. Covered Call Parameters
**Problem:** Old params (30-delta, 30 DTE) left too much on the table after assignment.  
**Decision:**
- Delta: 30 → 20 (more OTM, less risk of losing shares early)  
- DTE: 30 → 45 (more premium per cycle)  
- Added `evaluateAndRollCall()` — auto-rolls covered calls up-and-out when stock rallies to strike

### 5. Cost Basis Protection (Critical Fix)
**Problem:** In a sharp assignment scenario, the 10% OTM floor for the covered call could still be *below* what we paid for the shares (the put strike), locking in a guaranteed realized loss.  
**Decision:** Add third floor: `rawCcStrike = max(acquisitionPrice, 10%_floor, 20delta_from_chain)`. Log `inCostBasisProtectionMode` when this floor is binding.

### 6. Morning Brief
**Problem:** Pre-market research is manual and time-consuming.  
**Decision:** Automated AI brief — Finnhub (news + earnings + economic calendar) → Llama 70B → structured JSON → `morning_briefs` table → React UI.  
**Cloud scheduling:** pg_cron in Supabase so it runs at 8 AM ET with no laptop dependency.  
**On-demand:** "Generate Now" button in the app for any-time generation.

---

## Files Changed

| File | Change |
|------|--------|
| `auto-trader/src/lib/options-scanner.ts` | VIX-tiered delta, per-stock 200 SMA fetch, new constants, scan logging |
| `auto-trader/src/lib/options-manager.ts` | Roll logic (puts + calls), CC params (20δ/45DTE), cost-basis guard |
| `auto-trader/src/scheduler.ts` | Full-day scan windows, daily cap, morning brief cron, day trade management |
| `auto-trader/src/lib/morning-brief.ts` | New — Finnhub fetch + edge function call |
| `supabase/functions/generate-morning-brief/index.ts` | New — Groq/Llama synthesis + DB upsert |
| `app/src/components/MorningBrief.tsx` | New — Morning Brief UI (light theme, Generate Now, date selector) |
| `app/src/App.tsx` | Morning Brief route + nav (placed left of Options Wheel) |
| `app/src/components/PaperTrading/tabs/OptionsTab.tsx` | Removed source filter + "Your pick" badge |
| `app/src/lib/optionsApi.ts` | Fixed P&L calculation (include losses), WatchlistTicker interface |
| `supabase/migrations/20260424000003_options_roll_tracking.sql` | `roll_count`, `rolled_from_id` on `paper_trades` |
| `supabase/migrations/20260424000004_morning_briefs.sql` | New `morning_briefs` table |
| `supabase/migrations/20260424000005_morning_brief_pg_cron.sql` | pg_cron cloud schedule |

---

## Key Numbers / Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `VIX_SPIKE_THRESHOLD` | 30 | VIX > 30 = spike mode |
| `VIX_ELEVATED_THRESHOLD` | 25 | VIX 25–30 = elevated/conservative |
| `OPTIONS_MAX_NEW_PER_DAY` | 3 | Daily new-put cap |
| CC delta target | 0.20 | After assignment (was 0.30) |
| CC DTE target | 45 | After assignment (was 30) |
| 200 DMA proximity | 5% | Stock within 5% of SMA200 |
| Morning brief time | 8:00 AM ET | pg_cron at 12:00 UTC |
