# Product Requirements Document — Trading Signals

**Feature:** Trading Signals  
**Author:** keerti  
**Date:** 2026-02-06  
**Status:** Implemented

> **Implementation note (2026-02-08):** This PRD was the original design document. The current implementation extends it with Auto mode, a full technical indicator engine, market context, scenario analysis, and an expanded output schema. See [trade-signals-indicator-engine.md](../../../docs/trade-signals-indicator-engine.md) for the complete current-state reference. Key differences:
>
> - **Auto mode** added as the default (picks Day or Swing via ATR% + ADX)
> - **AI provider:** Google Gemini (multi-key rotation + model cascade), not Together AI
> - **News provider:** Yahoo Finance, not Finnhub
> - **Indicator engine:** RSI, MACD, EMA, SMA, ATR, ADX, Volume Ratio, S/R, MA Crossover, Trend Classification
> - **Market context:** SPY trend + VIX volatility included in every analysis
> - **Confidence:** Numeric 0-10 scale (not HIGH/MEDIUM/LOW)
> - **Dual targets:** targetPrice + targetPrice2
> - **Scenarios:** Bullish/neutral/bearish with probability estimates
> - **Frontend caching:** 15-min TTL for swing, 3-min for day trade
> - **Default mode:** Auto (not Swing)

**Related:** [Technical spec](./technical-spec-trading-signals.md) — prompts, data sources, pipelines, contracts, chart.

---

## 1. Executive Summary

**Vision:** A dedicated **Trading Signals** experience inside Portfolio Assistant that gives clear, mode-specific signals for **day trading** (minutes to hours) and **swing trading** (days to weeks). The user explicitly selects a mode; the entire pipeline (prompts, timeframes, risk rules) locks to that mode so every output is **coherent and intentional**.

**Principle:** One frontend, two brains, zero confusion.

**Place in product:** New surface (tab or section) alongside Portfolio, Suggested Finds, and Market Movers. Complements the existing portfolio AI analysis (which remains buy/sell/hold on existing holdings) by focusing on **actionable trade setups** with entry, stop, target, and rationale.

**Tech context:** Implementation uses the same app stack (React/Vite, Vercel, Supabase Edge Functions, server-side API keys). Trading Signals adds a new Edge Function and new providers (Together AI, Twelve Data for candles) while reusing Finnhub for news and the existing proxy/cache patterns. See the technical spec, §0 “Context: Existing App Stack & APIs,” for the full list of existing APIs and how this feature fits in.

---

## 2. Problem & Opportunity

**Problem:**  
- Current AI analysis is tuned for **portfolio holdings** and longer-term conviction, not for short-term day or swing setups.  
- Day and swing trading have different timeframes, risk/reward, and news sensitivity; mixing them in one pipeline produces mixed or confusing output.

**Opportunity:**  
- Users who want **intraday** or **multi-day swing** setups get a dedicated path.  
- Explicit **Day | Swing** choice avoids one-size-fits-all language and sets correct expectations (e.g. HOLD during chop for day; HOLD most of the time for swing).

---

## 3. Goals & Success Criteria

**Goals:**  
1. User can choose **Day Trade** or **Swing Trade** and receive signals that match that intent.  
2. Every signal includes **entry, stop, target, risk/reward, confidence, rationale** in a consistent shape.  
3. Prompts, timeframes, and risk rules are **fully aligned** with the selected mode (no mixed logic).

**Success (behavioral):**  
- Users use the Trading Signals surface when they are in "trade setup" mode.  
- Mode toggle is used (Day vs Swing) and output clearly reflects the chosen mode.  
- Users report that signals "make sense for what I selected."

**Success (quality):**  
- Same output schema for both modes so the UI stays simple and predictable.  
- Rationale and levels (entry/stop/target) feel consistent with the selected timeframe and R:R.

---

## 4. User Persona & Use Cases

**Persona:** Same core user as Portfolio Assistant (active retail investor) who also does **day or swing trading** and wants structured setups (entry, stop, target) with clear rationale.

**Use case — Day:**  
"I'm looking at intraday moves. I want signals that consider 1m/15m/1h, react to news quickly, and tell me when to HOLD during chop. Risk/reward around 1:1.5–1:2."

**Use case — Swing:**  
"I'm looking at multi-day holds. I want signals that use 4h/1d/1w, weigh news moderately, require trend alignment, and treat HOLD as the default. Risk/reward 1:2–1:4."

---

## 5. Mode Definitions (Explicit)

### Day Trade Mode

| Dimension | Definition |
|-----------|------------|
| **Intent** | Trades held **minutes to hours** |
| **Timeframes** | 1m / 15m / 1h |
| **Risk/Reward** | 1:1.5 – 1:2 |
| **News weighting** | **High** |
| **Output frequency** | **High** |
| **HOLD** | **Common during chop** |

### Swing Trade Mode

| Dimension | Definition |
|-----------|------------|
| **Intent** | Trades held **days to weeks** |
| **Timeframes** | 4h / 1d / 1w |
| **Risk/Reward** | 1:2 – 1:4 |
| **News weighting** | **Moderate** |
| **Trend alignment** | **Mandatory** |
| **HOLD** | **Expected most of the time** |

---

## 6. Under the Hood (Clean Separation)

**Flow:**

```
User selects mode
       ↓
Mode router
       ↓
DayTradeAgent  OR  SwingTradeAgent
       ↓
Unified output schema
       ↓
UI renderer
```

- **Mode router:** Reads persisted mode (Day | Swing); invokes only the corresponding agent.  
- **DayTradeAgent:** Day prompts, 1m/15m/1h context, high news weight, high output frequency, HOLD during chop.  
- **SwingTradeAgent:** Swing prompts (existing), 4h/1d/1w context, moderate news, trend alignment required, HOLD most of the time.  
- **Unified output schema:** Both agents emit the same fields so one UI can render both.  
- **UI renderer:** Single component that consumes the unified schema; no mode-specific rendering for the signal card itself.

---

## 7. Unified Output Schema

Both agents MUST output the same structure:

| Field | Type | Description |
|-------|------|-------------|
| **recommendation** | enum | BUY \| SELL \| HOLD |
| **entry** | number | Suggested entry level (price) |
| **stop** | number | Stop-loss level |
| **target** | number | Take-profit / target level |
| **risk/reward** | string or number | R:R ratio (e.g. "1:2" or 2) |
| **confidence** | enum | HIGH \| MEDIUM \| LOW |
| **rationale** | object or string | Mode-appropriate explanation (see technical spec for structure) |

*API field names* used in the backend and technical spec are `entryPrice`, `stopLoss`, `targetPrice`, `riskReward`; the UI can display these as “entry”, “stop”, “target”, “risk/reward”. Optional extensions (e.g. timeframe used, ticker, timestamp) can be added without breaking the core fields. The frontend MUST be able to render any signal from either agent using only this schema.

---

## 8. Functional Requirements (Summary)

**FR-1** — User can select **Day Trade** or **Swing Trade** via a single toggle (or equivalent control).  
**FR-2** — Selected mode is persisted (e.g. localStorage or user settings) and used on next visit.  
**FR-3** — Mode router passes the selected mode to the correct agent (DayTradeAgent or SwingTradeAgent) and does not mix modes.  
**FR-4** — DayTradeAgent uses day-specific prompts, 1m/15m/1h timeframes, high news weight, and R:R 1:1.5–1:2; HOLD is common during chop.  
**FR-5** — SwingTradeAgent uses swing-specific prompts, 4h/1d/1w timeframes, moderate news weight, trend alignment, and R:R 1:2–1:4; HOLD is expected most of the time.  
**FR-6** — Every signal returned to the UI conforms to the unified output schema (recommendation, entry, stop, target, risk/reward, confidence, rationale).  
**FR-7** — UI displays signals in a single, mode-agnostic layout (e.g. card or list) that only reflects the unified schema; mode is shown for context (e.g. "Day" or "Swing") but does not change the layout.  
**FR-8** — User can request new signals (e.g. refresh) and receive output consistent with the currently selected mode.

---

## 9. Non-Functional Requirements (Summary)

**NFR-1** — Output feels **coherent and intentional** for the selected mode (no day logic in swing output or vice versa).  
**NFR-2** — Latency acceptable for an on-demand signal (e.g. same order as existing AI analysis; no hard SLA in this PRD).  
**NFR-3** — Prompts and agent behavior are maintainable separately (two "brains") with a single contract (unified schema).

---

## 10. Phase 1 (Launch) Strategy

**Default:** Swing Trade  
**Optional toggle:** Day Trade (user can switch to it)  
**Hide:** Advanced comparisons in the first release (keep UI simple).

**Why this for launch:**

| Reason | Explanation |
|--------|-------------|
| **Swing feels more "AI-smart"** | Multi-day thesis and trend alignment read as considered, not reactive. |
| **Fewer false positives** | Day trading is noisier; swing signals are easier to keep quality high. |
| **Easier to justify with rationale** | Entry/stop/target over days–weeks is simpler to explain than intraday. |
| **Better first impression** | Users see coherent, defensible signals first; Day can be "power user" later. |

**Phase 1 scope:** Ship with Swing as default and Day as an optional toggle; no advanced comparison views. Expand (e.g. side-by-side, more day features) in a later phase.

---

## 11. Scope (Feature)

**In scope (this feature):**  
- Trading Signals surface (tab or section).  
- Day Trade \| Swing Trade mode selection and persistence.  
- Mode router and two agents (DayTradeAgent, SwingTradeAgent) with mode-specific prompts and rules.  
- Unified output schema and single UI renderer for signals.  
- Use of existing infrastructure (e.g. Supabase, AI proxy pattern) where applicable.

**Out of scope (this PRD):**  
- Automated execution or broker integration.  
- Real-time streaming of prices (data refresh cadence is a separate design choice).  
- Changing the existing Portfolio tab AI analysis (that remains focused on portfolio holdings).

---

## 12. Dependencies & Assumptions

**Dependencies:**  
- Existing app (Portfolio Assistant) and its deployment (Vercel, Supabase).  
- Availability of market/data APIs suitable for the chosen timeframes (1m/15m/1h for day; 4h/1d/1w for swing). See [technical spec](./technical-spec-trading-signals.md) for candidate providers.  
- Swing trading prompts (already in hand); day trading prompts defined in technical spec.

**Assumptions:**  
- One active mode per user session (Day or Swing).  
- Signals are generated on demand (or on a defined refresh), not streamed continuously.  
- Unified schema is sufficient for both modes; no need for mode-only fields in the first version.

---

## 13. Open Questions (Pre-Implementation)

1. **Placement:** New top-level tab ("Trading Signals") vs subsection under an existing tab.  
   *Recommendation for Phase 1:* Use a top-level tab (e.g. `/signals`) for clarity; subsection can be revisited if navigation grows.
2. **Inputs:** Does the user pick symbols for signals, or do we derive from portfolio + market movers + suggested finds?  
   *Recommendation for Phase 1:* User enters or selects **one ticker** for an on-demand signal; optional later: quick-pick from portfolio / movers / finds.

(Data sources and prompt details are in the [technical spec](./technical-spec-trading-signals.md).)

---

## 14. Document History

| Date | Change |
|------|--------|
| 2026-02-06 | Initial PRD created; mode definitions, pipeline, and unified schema captured. Analysis only; no epic commitment. |
| 2026-02-06 | Phase 1 (launch) strategy added: default Swing Trade, optional Day Trade toggle, hide advanced comparisons. |
| 2026-02-06 | Reorganized: PRD moved to features/trading-signals/; implementation detail split into technical-spec-trading-signals.md. |
| 2026-02-06 | Tech context added (stack/APIs); open questions updated with Phase 1 recommendations; schema note for API field names. |
