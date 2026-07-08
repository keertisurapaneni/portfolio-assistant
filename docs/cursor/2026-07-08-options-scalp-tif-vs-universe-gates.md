# ADR: Options Scalp — TIF vs Universe Gates

**Date:** 2026-07-08  
**Status:** Accepted  
**Context:** After PR #486 (basketball EOD scope + DAY TIF for 0DTE), the question came up: if options orders are DAY, do we still need different ETF vs non-ETF scalp rules?

## Decision

Keep **two orthogonal product gates**. Do not collapse them.

| Gate | Job | Knob |
|------|-----|------|
| **A — TIF** | How long does the resting order live? | DAY for same-day expiry; GTC for multi-day |
| **B — Universe / expiry** | May we open this scalp on this underlier today? | ETF 0DTE Mon–Thu; stock weeklies only as intentional carve-outs; full watchlist Friday |

## Why not unify

1. **DAY does not create a contract.** Most stocks lack Mon–Thu daily chains → IB code-200.
2. **DAY does not change filled-position risk.** Next-Friday fill still carries overnight / multi-DTE risk.
3. **Jun 29 loss** (~$3.5k APP/MSFT/GOOGL/PLTR/HOOD) was universe selection, not TIF.
4. **AMD/PLTR Mon–Thu weeklies** are a deliberate exception (Jul 1). One ruleset either kills that or silently re-expands the universe.

Unifying "for simplicity" is a **strategy change**, not a cleanup. It needs a P&L argument and explicit user approval.

## Alternatives considered

- **Friday-for-all Mon–Thu** — rejected (PR #472). Violates Kay Capitals 0DTE.
- **Scan everyone, skip on code-200** — rejected for ORB (Jun 29). Wastes IB calls and previously burned premium when wrong expiries filled.
- **Same entry/exit logic once a valid 0DTE contract exists** — allowed. Gate B is about *eligibility*, not about forking profit/stop math.

## Enforcement

- Product rule: `.cursor/rules/options-scalp-strategy.mdc` → "Two Orthogonal Gates"
- Code: `options-scalp.ts` (`VWAP_ETF_ONLY_UNIVERSE`, per-ticker expiry); `ib-connection.ts` (`placeOptionsOrder` TIF default)
- History: `docs/cursor/discrepancy-fixes-log.md` (Jun 24 #472, Jun 29 ORB, Jul 1 AMD/PLTR, Jul 8 #486)
