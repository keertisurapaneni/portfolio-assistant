# Expiry Diversification + Calendar Spread Foundation

**Date:** 2026-05-15

## Problem: Expiry Concentration Risk

All 11 open options positions shared the same expiry (June 19, 2026). Root cause:
`pickBestExpiry` targets ~38 DTE and always converges on the nearest monthly option
(third Friday). Since all tickers are scanned in the same window, they all land on
the same date.

**Risk:** One bad week = all positions threatened simultaneously. No staggering.

## Fix: Three-Layer Expiry Intelligence

### 1. Minimum DTE Floor (21 days)
Per Brad Castro / OptionsPlay "sweet spot" guidance: 3 weeks to 45 days is optimal
for selling options. Raised minimum from 14 to 21 DTE. When the current monthly is
< 21 DTE, auto-roll to the next monthly.

### 2. Earnings-Through-Expiry Prevention
The existing 7-day earnings blackout prevents entry when earnings are imminent. But
it didn't check whether the chosen expiry straddles earnings (e.g. earnings in 20
days, expiry at 38 DTE = selling through earnings). Now `getOptionsChain` accepts
an `earningsBefore` constraint that filters out expiries on/after the earnings date.

### 3. Expiry Week Concentration Cap
Max 3 positions per expiry week. When a week is crowded, the scanner prefers the
next available expiry (typically the following monthly). Falls back to the crowded
week only if no alternatives exist within the DTE window.

## Files Changed

- `auto-trader/src/lib/options-chain.ts` — `ExpiryConstraints` interface,
  `pickBestExpiry` and `pickBestExpiryForDte` now accept `avoidWeeks` + `earningsBefore`,
  `getOptionsChain` passes constraints through to both live IB and synthetic chains
- `auto-trader/src/lib/options-scanner.ts` — `ScanContext.openExpiryWeekCount`,
  constraint building in `checkStock`, running expiry tracking in `runOptionsScan`

## Calendar Spread Implementation Plan

### Phase 1: Foundation (Week 1)
- [ ] Add `CalendarSpreadTicket` type to options-scanner
- [ ] IB combo order support (`BAG` contract with two legs)
- [ ] Calendar spread scanner: identify tickers where front-month IV > back-month IV
- [ ] Paper trade recording for multi-leg positions

### Phase 2: Execution (Week 2)
- [ ] Auto-execution with human approval gate (Slack notification → approve/reject)
- [ ] Position monitoring: track front leg expiry, auto-close or roll
- [ ] P&L tracking for spread positions (net debit/credit at entry vs current spread value)

### Phase 3: Double Calendars (Week 3)
- [ ] Put calendar + call calendar combination
- [ ] Wider profit zone targeting for range-bound tickers
- [ ] Integration with existing IV rank / BB / sector analysis

### Phase 4: UI + Optimization (Week 4)
- [ ] Calendar spread section in Options tab
- [ ] Auto-tuning: which tickers work best for calendars vs naked puts
- [ ] Performance tracking and win rate by strategy

### Key Design Decisions
- **Defined risk only** — max loss = net debit paid. No naked short legs.
- **Human approval required** for all live calendar spread trades initially
- **Small sizing** — 1 contract per spread, $500 max risk per position
- **Front leg**: 21-30 DTE (sell). **Back leg**: 45-60 DTE (buy).
- **Entry criteria**: IV rank > 40, front IV > back IV (term structure inversion),
  stock in a range (BB width < 20%), no earnings between legs
