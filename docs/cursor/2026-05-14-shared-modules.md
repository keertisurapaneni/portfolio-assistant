# Shared Modules — Single Source of Truth

**Date:** 2026-05-14
**Goal:** Eliminate config/type/constant duplication across auto-trader, frontend, and edge functions.

## Problem

The codebase had identical types, constants, and utility functions duplicated across three runtimes:
- **Auto-trader** (Node.js/tsc) — `auto-trader/src/`
- **Frontend** (Vite/React) — `app/src/`
- **Edge functions** (Deno) — `supabase/functions/`

This caused drift: e.g., `minScannerConfidence` defaulted to 6 in the frontend but 7 in the backend, `lossCutTier1Pct` was 8 vs 6, status arrays had different members across files.

## Solution

Created `shared/` at the repo root with pure TypeScript modules (no runtime dependencies). All three consumers import from it.

### Shared modules

| File | Contents |
|------|----------|
| `config-defaults.ts` | `AutoTraderConfig` interface + `DEFAULT_CONFIG` object |
| `trade-types.ts` | `PaperTrade`, `TradeStatus`, `TradeMode`, `CloseReason`, `TradeSignal` |
| `auto-trade-events.ts` | `AutoTradeAction`, `AutoTradeSource`, `AutoTradeEventType`, `AutoTradeEventInput`, `AutoTradeEventRecord` |
| `trade-status-sets.ts` | `ACTIVE_STATUSES`, `CLOSED_STATUSES`, `EXCLUDED_STATUSES`, `ALL_TERMINAL_STATUSES`, `EQUITY_MODES`, `OPTIONS_MODES` |
| `date-helpers.ts` | `getETNow`, `getETDateString`, `formatDateToEtIso`, `toEtIsoDate`, `isMarketOpen` |
| `format.ts` | `fmtUsd`, `fmtUsdCompact` |
| `index.ts` | Barrel re-export |

### How imports work per runtime

- **Auto-trader (NodeNext)**: `tsconfig.json` sets `rootDir: ".."` and includes `../shared/**/*`. Import with `.js` extension: `import { X } from '../../../shared/module.js'`
- **Frontend (Vite)**: `tsconfig.app.json` includes `../shared`. Import with `.ts` extension: `import { X } from '../../../shared/module.ts'`
- **Edge functions (Deno)**: Direct `.ts` imports: `import { X } from '../../../shared/module.ts'`
- **`shared/package.json`** contains `{ "type": "module" }` so tsc emits ESM for the auto-trader build.

### Build output change

The auto-trader's `rootDir: ".."` change means compiled output goes to `dist/auto-trader/src/` instead of `dist/`. The `npm start` script was updated to `node dist/auto-trader/src/index.js`.

## Key decisions

- **Backend is source of truth** — shared defaults match `auto-trader/src/lib/supabase.ts` values.
- **Superset interface** — `PaperTrade` in shared includes all fields from both frontend and backend. Optional fields (`price_peak`, `ib_tp_order_id`, etc.) are nullable.
- **Consumer extensions** — Frontend extends `AutoTraderConfig` with `suggestedFindPositionSize` (frontend-only field).
- **`[...ARRAY]` for Supabase** — Supabase `.in()` requires mutable arrays, so shared readonly arrays are spread.
- **Local functions can wrap shared ones** — e.g., scheduler keeps `isMarketHoursET()` with extended hours while importing shared `isMarketOpen()` for standard RTH.

## Dynamic bucket rebalancing

Also added: when `suggestedFindsEnabled=false`, the long-term bucket allocation (`longTermBucketPct`) is effectively 0, redirecting all capital to day/swing. Existing long-term positions are still managed (profit-taking, loss-cutting) regardless.

## Adding a new config field

1. Add the field to `shared/config-defaults.ts` (interface + default value)
2. Add the snake_case DB column mapping in `auto-trader/src/lib/supabase.ts` `loadConfig()`
3. Add the same mapping in `app/src/lib/autoTrader.ts` `loadAutoTraderConfig()`
4. If auto-tune should adjust it, add bounds in `supabase/functions/auto-tune-strategy-config/index.ts`

## Adding a new trade status

1. Add it to `TradeStatus` in `shared/trade-types.ts`
2. Add it to the appropriate set in `shared/trade-status-sets.ts`
3. Add styling in `app/src/components/PaperTrading/shared/StatusBadge.tsx`
