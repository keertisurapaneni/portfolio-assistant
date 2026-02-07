# Epic 13: Trading Signals — Day Trade | Swing Trade

A new **Trading Signals** experience with explicit mode selection. Once the user selects a mode, the **entire pipeline locks to that mode**: prompts, timeframes, risk rules, and output all adapt so the result feels **coherent and intentional**.

**UI:** Toggle — **Day Trade | Swing Trade** (single selection, entire pipeline follows it).

**Builds on:** Existing AI/proxy patterns (Groq or Gemini as needed), portfolio/conviction data, and market data APIs.

---

## Mode Definitions (Explicit)

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

## Design Principle (Pipeline Lock)

- **Once selected:** Entire pipeline locks to that mode.
- **Prompts** — Day vs Swing prompts (user has swing prompts; day prompts to be defined).
- **Timeframes** — 1m/15m/1h (Day) vs 4h/1d/1w (Swing) drive data and narrative.
- **Risk rules** — Risk/reward and position rules adapt per mode (e.g. 1:1.5–1:2 vs 1:2–1:4).
- **Output** — Feels coherent and intentional for the chosen mode (no mixed signals).

---

## Under the Hood (Clean Separation)

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

**One frontend, two brains, zero confusion.**

### Unified Output Schema (both agents)

Both agents emit the **same fields** so the UI has a single contract:

| Field | Description |
|-------|-------------|
| **recommendation** | BUY / SELL / HOLD |
| **entry** | Suggested entry level |
| **stop** | Stop-loss level |
| **target** | Take-profit / target level |
| **risk/reward** | R:R ratio (e.g. 1:2) |
| **confidence** | Confidence level (e.g. HIGH / MEDIUM / LOW) |
| **rationale** | Short explanation |

- **Mode router** — Reads selected mode (Day | Swing), invokes the correct agent only.
- **DayTradeAgent** — Uses day prompts, 1m/15m/1h, high news weight, high frequency, HOLD during chop.
- **SwingTradeAgent** — Uses swing prompts, 4h/1d/1w, moderate news, trend alignment, HOLD most of the time.
- **UI renderer** — Single component that consumes the unified schema; no mode-specific rendering branches for the signal card itself.

---

## Stories (To Be Broken Down)

- **13.1** — UI: Trading Signals tab/section + Day Trade | Swing Trade toggle; selection persisted (e.g. localStorage/settings).
- **13.2** — Pipeline lock: All prompts, timeframe references, and risk rules keyed off selected mode.
- **13.3** — Day Trade: Prompts, data (1m/15m/1h), news-high, high output frequency, HOLD during chop.
- **13.4** — Swing Trade: Prompts (user’s existing swing prompts), data (4h/1d/1w), moderate news, trend alignment mandatory, HOLD most of the time.
- **13.5** — Risk/reward and display: Show/apply 1:1.5–1:2 (Day) vs 1:2–1:4 (Swing) in rules and copy.

---

## Status

**State:** Captured — not yet implemented.  
**Prompts:** Swing prompts available; day prompts to be defined/aligned with above.
