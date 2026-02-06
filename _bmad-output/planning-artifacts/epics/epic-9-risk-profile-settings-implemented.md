# Epic 9: Risk Profile Settings (IMPLEMENTED)

Users can select a risk profile (Aggressive/Moderate/Conservative) that adjusts trading thresholds across the entire application.

**Status:** ✅ Fully implemented

**New FRs covered:**

- FR65: Users can select risk profile from Settings modal
- FR66: Risk profile adjusts stop-loss, profit-take, and max position thresholds
- FR67: Risk profile persists in localStorage
- FR68: AI guardrails and trigger detection use risk-profile-adjusted thresholds

## Story 9.1: Risk Profile Settings

As an investor,
I want to choose my risk tolerance level,
So that trade signals match my investing style.

**Acceptance Criteria:**

**Given** I open Settings (gear icon)
**When** I select Aggressive, Moderate, or Conservative
**Then** all thresholds adjust accordingly:

- Aggressive: -4% stop-loss, +25% profit-take, 30% max position
- Moderate: -7% stop-loss, +20% profit-take, 25% max position
- Conservative: -5% stop-loss, +20% profit-take, 20% max position
  **And** the next AI refresh uses the new thresholds
  **And** my selection persists across sessions

---
