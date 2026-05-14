# 2026-05-14: EOD Sweep State Desync & Influencer Attribution

## What happened

### Orphaned shorts overnight
4 short positions (TLT, GD, MSFT, AVY) survived the EOD sweep and were held overnight.
At 9:12 AM the next day, `reconcileIBShorts()` auto-covered them at market-open prices (~$16K).

**Root cause:** `closeAllDayTrades()` marked paper_trades as CLOSED even when the IB cover
order was rejected (`catch { log("marking CLOSED in DB anyway") }`). The DB thought positions
were flat; IB still held the shorts. `reconcileIBShorts()` then tried to cover after market
close with MKT/DAY orders that couldn't fill.

### Influencer attribution stripped
Somesh's trades showed as generic "Trade signal" in the activity log instead of showing
the influencer source name.

**Root cause:** Commit `0af5475` (April 22) added `alsoInScanner ? null : signal.source_name`
which stripped attribution when the scanner independently found the same ticker. This was an
intentional design decision at the time that turned out to be wrong — the whole point of
tracking influencer signals is to measure their performance separately.

## Decisions made

1. **Never mark CLOSED if IB order fails.** Leave status unchanged; next sweep retries.
2. **Always preserve influencer attribution.** Scanner overlap goes in metadata, not source override.
3. **Market-hour gate on reconcileIBShorts.** Defer and alert after hours, schedule retry at 9:31 AM.
4. **4:10 PM IB position check.** New cron job queries IB directly for orphaned positions.
5. **9:35 AM gate should apply to influencer signals too.** Not yet implemented — noted as TODO.

## New rules created

- `.cursor/rules/auto-trader-invariants.mdc` — hard never-violate rules
- `.cursor/rules/ai-guardrails.mdc` — process guardrails for AI editing trading code
- Updated `.cursor/rules/influencer-signals.mdc` — added attribution and timing rules

## Lesson learned

The AI flip-flopped on design decisions across sessions because there was no persistent
specification to check against. Tests and rule files are the only things that survive between
AI sessions. Without them, each session re-derives intent from the code and sometimes gets
it wrong. The new rule files encode these decisions so future sessions can't silently override them.
