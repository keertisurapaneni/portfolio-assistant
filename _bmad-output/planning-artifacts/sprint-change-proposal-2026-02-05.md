---
date: 2026-02-05
author: Bob (Scrum Master)
project: portfolio-assistant
change_scope: Moderate
status: Pending Approval
---

# Sprint Change Proposal: Multi-User Access & Deployment Architecture

## Section 1: Issue Summary

### Problem Statement

The Portfolio Assistant app was built with `localStorage` as the primary data persistence mechanism, which only supports single-device, browser-only access. However, the Product Brief explicitly specifies **"up to 10 users"** (2 power users + up to 8 regular users) need access to the application.

### Context & Discovery

**When Discovered:** Post-implementation, during deployment planning  
**Discovery Method:** User question: "How will other users access this? I don't have a domain."  
**Severity:** Blocking deployment - app cannot be shared with other users in current state

### Evidence

1. **Product Brief (Line 80-87):** Explicitly states "up to 10 users" requirement
2. **Product Brief (Line 104-118):** Describes independent user journeys for each of the 10 users
3. **Technical Spec (Line 17):** Documents `localStorage` as storage, with no hosting plan
4. **Current Implementation:** All data stored in browser localStorage, no backend, no authentication, no deployment configuration

### Root Cause

The project used **Quick Dev (QD)** workflow instead of the full BMAD planning cycle, which bypassed:

- ❌ Create Architecture (CA) - required workflow skipped
- ❌ Check Implementation Readiness (IR) - required workflow skipped

Winston (Architect) would have identified this gap during the Architecture workflow.

---

## Section 2: Impact Analysis

### Epic Impact

**Note:** Project used Quick Dev, no formal epics exist. Analysis by functional area:

| Functional Area          | Impact   | Changes Needed                                              |
| ------------------------ | -------- | ----------------------------------------------------------- |
| **Conviction Dashboard** | Low      | Works as-is for guest mode; needs cloud sync for auth users |
| **Portfolio Import**     | Low      | Works as-is; needs migration helper for guest→auth          |
| **Suggested Finds**      | None     | No changes needed                                           |
| **Data Storage**         | **High** | Must add hybrid storage layer (localStorage + Supabase)     |
| **User Management**      | **High** | Must add optional authentication system                     |
| **Deployment**           | **High** | Must add hosting configuration (Vercel + Supabase)          |

### Story Impact

No formal stories exist. Implementation will be treated as new work items.

### Artifact Conflicts

#### Product Brief

**Status:** Minor additions needed  
**Changes Required:**

- Add hosting strategy section
- Document authentication approach (optional)
- Clarify multi-user access model (guest + authenticated)

#### Technical Specification

**Status:** Major updates needed  
**Changes Required:**

- Replace localStorage-only with hybrid storage architecture
- Add backend infrastructure (Supabase)
- Add authentication system documentation
- Add deployment strategy (Vercel + Supabase)
- Document data migration path (guest → authenticated)
- Add environment variable configuration

#### UX Design Specification

**Status:** Minor additions needed  
**Changes Required:**

- Add optional sign up/login UI
- Add guest mode banner
- Add portfolio migration prompt
- Add account management UI

### Technical Impact

| Area           | Impact | Details                                                    |
| -------------- | ------ | ---------------------------------------------------------- |
| **Frontend**   | Medium | Add auth UI, hybrid storage layer, migration helper        |
| **Backend**    | High   | New Supabase project, database schema, edge functions      |
| **Deployment** | High   | New Vercel project, environment variables, CI/CD           |
| **Data Model** | Medium | Add user_id associations, maintain backwards compatibility |

### Future Considerations

**LLM Integration Plans (V2 Roadmap):**

- User confirmed LLM features coming "soon" (1-2 months)
- LLM API calls require backend (can't expose keys in browser)
- Supabase Edge Functions will enable LLM features without additional infrastructure

**Decision:** Build with Supabase now to avoid painful migration later.

---

## Section 3: Recommended Approach

### Selected Path: **Direct Adjustment - Hybrid Architecture**

Add authentication and cloud storage **as optional features** while preserving existing localStorage functionality as guest mode.

### Architecture Overview

**Hybrid Mode Strategy:**

```
┌─────────────────────────────────────────────────────────┐
│                   PORTFOLIO ASSISTANT                    │
│                                                          │
│  ┌──────────────────┐         ┌────────────────────┐   │
│  │   Guest Mode     │         │  Authenticated     │   │
│  │   (Default)      │         │      Mode          │   │
│  │                  │         │    (Optional)      │   │
│  │ • No login       │         │ • Email/password   │   │
│  │ • localStorage   │  ────▶  │ • Cloud sync       │   │
│  │ • Single device  │         │ • Multi-device     │   │
│  │ • Full features  │         │ • Supabase DB      │   │
│  └──────────────────┘         └────────────────────┘   │
│                                                          │
│  Frontend: Vercel (Static Hosting)                      │
│  Backend: Supabase (PostgreSQL + Auth + Edge Functions) │
└─────────────────────────────────────────────────────────┘
```

### Key Benefits

1. **Zero Friction Onboarding** - Users can try the app immediately without signup
2. **Graceful Upgrade Path** - Guest users can upgrade to cloud sync anytime
3. **LLM-Ready** - Backend infrastructure in place for future AI features
4. **Cost Effective** - Supabase free tier supports 10 users easily
5. **Low Risk** - Additive changes, doesn't break existing functionality

### Effort Estimate

| Task                                         | Effort      | Risk    |
| -------------------------------------------- | ----------- | ------- |
| Supabase setup (DB + Auth + Edge Functions)  | 2 hours     | Low     |
| Hybrid storage layer implementation          | 2 hours     | Low     |
| Optional auth UI (signup/login)              | 1.5 hours   | Low     |
| Data migration helper (localStorage → cloud) | 1 hour      | Medium  |
| Vercel deployment configuration              | 0.5 hours   | Low     |
| Documentation updates                        | 1 hour      | Low     |
| **Total**                                    | **8 hours** | **Low** |

### Risk Assessment

| Risk                    | Likelihood | Impact | Mitigation                            |
| ----------------------- | ---------- | ------ | ------------------------------------- |
| Supabase learning curve | Medium     | Low    | Excellent docs, common pattern        |
| Data migration bugs     | Low        | Medium | Thorough testing, backup localStorage |
| Auth complexity         | Low        | Low    | Supabase handles heavy lifting        |
| Free tier limits        | Low        | Low    | 10 users well within limits           |

### Timeline Impact

- **MVP Features:** ✅ All complete, no changes needed
- **Additional Time:** +8 hours for deployment architecture
- **Total Project Time:** 10-15 hours (original) + 8 hours = 18-23 hours
- **Still within personal project scope** ✅

---

## Section 4: Detailed Change Proposals

### Proposal 1: Update Technical Specification

**File:** `_bmad-output/planning-artifacts/technical_spec_v1.md`

**Section:** Tech Stack (Lines 7-19)

**OLD:**

```markdown
| **State** | React useState/useEffect | Simple, no external state library needed |
| **Storage** | localStorage | No backend, data persists in browser |
```

**NEW:**

```markdown
| **State** | React useState/useEffect | Simple, no external state library needed |
| **Storage** | Hybrid: localStorage + Supabase | Guest mode (localStorage) + Optional cloud sync |
| **Backend** | Supabase (PostgreSQL + Edge Fns) | Optional auth, cloud storage, future LLM calls |
| **Auth** | Supabase Auth | Optional email/password authentication |
| **Hosting** | Vercel (frontend) | Free static hosting with automatic deploys |
```

**Rationale:** Documents the hybrid architecture that supports both guest and authenticated modes.

---

**Section:** New section to add after "Tech Stack"

**ADD:**

````markdown
## Deployment Architecture

### Hosting Strategy

| Component    | Provider         | Purpose                                             | Cost                                            |
| ------------ | ---------------- | --------------------------------------------------- | ----------------------------------------------- |
| **Frontend** | Vercel           | Static site hosting, automatic deploys from Git     | Free                                            |
| **Backend**  | Supabase         | PostgreSQL database, authentication, edge functions | Free (up to 500MB DB, 50K monthly active users) |
| **Domain**   | Vercel subdomain | `portfolio-assistant.vercel.app`                    | Free                                            |

### Access Model: Hybrid Guest + Authenticated

**Guest Mode (Default):**

- No login required
- Data stored in browser localStorage
- Full app functionality
- Single-device access
- Perfect for evaluation and single-user use

**Authenticated Mode (Optional):**

- Email/password signup
- Portfolio data synced to Supabase PostgreSQL
- Multi-device access
- Data persists across browsers
- Required for future LLM features

**Migration Path:**
When guest user signs up:

1. Detect existing localStorage portfolio
2. Prompt: "You have a local portfolio. Import it to your account?"
3. One-click migration to cloud storage

### Data Architecture

**Supabase Schema:**

```sql
-- Users table (managed by Supabase Auth)
-- auth.users (built-in)

-- Stocks table
CREATE TABLE stocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT,
  date_added TIMESTAMP DEFAULT NOW(),
  shares NUMERIC,
  avg_cost NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, ticker)
);

-- Cached stock data table (for API efficiency)
CREATE TABLE stock_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  cached_at TIMESTAMP DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own stocks
CREATE POLICY "Users can view own stocks"
  ON stocks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own stocks"
  ON stocks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own stocks"
  ON stocks FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own stocks"
  ON stocks FOR DELETE
  USING (auth.uid() = user_id);
```
````

### Storage Layer Implementation

```typescript
// lib/storage.ts - Hybrid storage abstraction
interface StorageAdapter {
  getPortfolio(): Promise<Stock[]>;
  savePortfolio(stocks: Stock[]): Promise<void>;
  addStock(stock: Stock): Promise<void>;
  removeStock(ticker: string): Promise<void>;
  clearAll(): Promise<void>;
}

// Guest mode: localStorage
class LocalStorageAdapter implements StorageAdapter {
  // ... existing localStorage logic
}

// Authenticated mode: Supabase
class SupabaseStorageAdapter implements StorageAdapter {
  // ... Supabase queries with RLS
}

// Factory based on auth state
export function getStorageAdapter(user: User | null): StorageAdapter {
  return user ? new SupabaseStorageAdapter(user) : new LocalStorageAdapter();
}
```

### Environment Variables

```bash
# .env.local
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_FINNHUB_API_KEY=your-finnhub-key
```

### Future LLM Integration (V2)

Supabase Edge Functions will host LLM API calls:

```typescript
// supabase/functions/analyze-gold-mines/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async req => {
  const { headlines } = await req.json();

  // Call OpenAI/Claude API (key stored securely in Supabase)
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: `Analyze these headlines: ${headlines}` }],
    }),
  });

  return new Response(JSON.stringify(await response.json()));
});
```

````

**Rationale:** Comprehensive deployment architecture documentation that was missing from original spec.

---

### Proposal 2: Update Product Brief

**File:** `_bmad-output/planning-artifacts/product-brief-portfolio-assistant-2026-02-04.md`

**Section:** User Interaction Model (after Line 118)

**ADD:**
```markdown
### Access Modes

**Guest Mode (No Login Required):**
- Default experience for all users
- Try all features immediately
- Data stored locally in browser
- Perfect for evaluation or single-device use

**Authenticated Mode (Optional Cloud Sync):**
- Sign up with email/password
- Portfolio synced across devices
- Access from any browser
- Required for future LLM-powered features

**User Choice:** Each of the 10 users decides independently whether to use guest or authenticated mode based on their needs.
````

**Rationale:** Clarifies how the "up to 10 users" requirement is fulfilled without forcing authentication on everyone.

---

### Proposal 3: Update UX Design Specification

**File:** `_bmad-output/planning-artifacts/ux-design-specification.md`

**Section:** New section after "Page/Tab Structure"

**ADD:**

```markdown
### Authentication Flow (Optional)

**Guest Mode Banner (Subtle, Non-Intrusive):**
```

┌─────────────────────────────────────────────────────────┐
│ Portfolio Assistant [Sign Up] [Login]│
├─────────────────────────────────────────────────────────┤
│ ℹ️ Using guest mode. Data saved locally in this │
│ browser. Sign up to sync across devices. [Dismiss] │
├─────────────────────────────────────────────────────────┤
│ [ My Portfolio ] [ Suggested Finds ] │

```

**Sign Up Modal:**
```

┌─────────────────────────────────────────────────────────┐
│ CREATE ACCOUNT [Close X] │
├─────────────────────────────────────────────────────────┤
│ Email: │
│ ┌─────────────────────────────────────────────────┐ │
│ │ │ │
│ └─────────────────────────────────────────────────┘ │
│ │
│ Password: │
│ ┌─────────────────────────────────────────────────┐ │
│ │ │ │
│ └─────────────────────────────────────────────────┘ │
│ │
│ ✓ You have a local portfolio. Import it after signup? │
│ │
│ [Cancel] [Create Account] │
└─────────────────────────────────────────────────────────┘

```

**Migration Prompt (After Signup):**
```

┌─────────────────────────────────────────────────────────┐
│ IMPORT LOCAL PORTFOLIO? [Close X] │
├─────────────────────────────────────────────────────────┤
│ We found 8 stocks in your local browser storage. │
│ │
│ Would you like to import them to your new account? │
│ │
│ ┌─────────────────────────────────────────────────┐ │
│ │ ✓ AAPL Apple Inc 15% portfolio │ │
│ │ ✓ NVDA NVIDIA Corp 8% portfolio │ │
│ │ ✓ META Meta Platforms 12% portfolio │ │
│ │ ... 5 more stocks │ │
│ └─────────────────────────────────────────────────┘ │
│ │
│ [Skip for Now] [Import All Stocks] │
└─────────────────────────────────────────────────────────┘

```

**Account Menu (When Logged In):**
```

┌─────────────────────────────────────────────────────────┐
│ Portfolio Assistant [keerti@example.com ▼]│
│ ┌──────────────────┐ │
│ │ Account Settings │ │
│ │ Logout │ │
│ └──────────────────┘ │

```

```

**Rationale:** Documents the optional authentication UX that preserves the frictionless guest experience.

---

## Section 5: Implementation Handoff

### Change Scope Classification: **Moderate**

**Rationale:**

- Not a minor change (adds significant infrastructure)
- Not a major replan (core features unchanged, MVP intact)
- Moderate: Requires new architecture components + doc updates

### Handoff Plan

**Phase 1: Architecture Documentation**

- **Assigned To:** Winston (Architect)
- **Deliverables:**
  - Detailed architecture document
  - Database schema design
  - API integration patterns
  - Security considerations
- **Estimated Time:** 2 hours

**Phase 2: Implementation**

- **Assigned To:** Development Team (Amelia or Quick Flow Dev)
- **Deliverables:**
  - Supabase project setup
  - Hybrid storage layer
  - Authentication UI
  - Data migration helper
  - Vercel deployment
- **Estimated Time:** 6 hours

**Phase 3: Documentation Updates**

- **Assigned To:** Technical Writer (Paige) - Optional
- **Deliverables:**
  - Updated planning artifacts (as detailed in proposals above)
  - Deployment guide
  - User documentation
- **Estimated Time:** 1 hour

### Success Criteria

✅ **Deployment:**

- App accessible at public URL (e.g., `portfolio-assistant.vercel.app`)
- No domain purchase required (Vercel subdomain sufficient)

✅ **Guest Mode:**

- Users can access full app without signup
- Data persists in localStorage
- No degraded functionality

✅ **Authenticated Mode:**

- Users can sign up with email/password
- Portfolio data syncs to Supabase
- Multi-device access works
- Migration from guest mode successful

✅ **Documentation:**

- All planning artifacts updated per proposals
- Architecture clearly documented
- Deployment process documented

✅ **Future-Proof:**

- Backend infrastructure ready for LLM features
- No re-architecture needed for V2

### Dependencies

- Supabase account (free tier)
- Vercel account (free tier)
- No domain purchase required
- No credit card required for MVP deployment

---

## Section 6: Next Steps

### Immediate Actions

1. **User Approval** - Review and approve this Sprint Change Proposal
2. **Invoke Winston** - Architect to create detailed architecture document
3. **Begin Implementation** - Following Winston's architecture guidance

### Timeline

- Sprint Change Proposal: Complete (this document)
- Architecture Design: 2 hours
- Implementation: 6 hours
- Documentation: 1 hour
- **Total Additional Time:** 8-9 hours

### Post-Implementation

- Deploy to Vercel
- Share URL with the 10 target users
- Monitor usage (guest vs. authenticated adoption)
- Prepare for V2 LLM features (infrastructure already in place)

---

## Appendix: Decision Log

| Decision                         | Rationale                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| **Hybrid Mode (Guest + Auth)**   | Better UX than forced login; allows immediate evaluation         |
| **Supabase over Custom Backend** | Faster to build, free tier generous, edge functions for LLM      |
| **Vercel over Other Hosts**      | Best React/Vite integration, free tier, automatic deploys        |
| **Optional Auth (not Required)** | User feedback: "users should be able to use without logging in"  |
| **Email/Password (not OAuth)**   | Simpler for 10-user personal project; can add OAuth later        |
| **Build Now (not Later)**        | LLM features coming "soon" (1-2 months); avoid painful migration |

---

**Status:** Awaiting user approval to proceed to architecture design phase with Winston (Architect).

**Prepared By:** Bob (Scrum Master)  
**Date:** 2026-02-05
