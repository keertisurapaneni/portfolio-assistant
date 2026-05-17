# Dual-Account Architecture: Paper + Live Auto-Trading

**Date:** 2026-05-17  
**Status:** Implementation Plan  
**Goal:** Run the auto-trader against both a paper and live IB account simultaneously, with mode-based routing, physical table isolation for trade-critical data, and a frontend account switcher.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Phase 1: Database Migrations](#2-phase-1-database-migrations)
3. [Phase 2: Auto-Trader Connection Registry](#3-phase-2-auto-trader-connection-registry)
4. [Phase 3: Trade Execution Routing](#4-phase-3-trade-execution-routing)
5. [Phase 4: Frontend Account Switcher](#5-phase-4-frontend-account-switcher)
6. [Phase 5: Kill Switches & Safety Guards](#6-phase-5-kill-switches--safety-guards)
7. [Phase 6: Testing & Validation](#7-phase-6-testing--validation)

---

## 1. Architecture Overview

### Current State

```
auto-trader (Node.js)
  └── IBApi (port 4002, paper) ──→ IB Gateway (paper account)
  └── Supabase
        ├── paper_trades
        ├── auto_trade_events
        ├── ib_fills
        ├── strategy_streak_state
        ├── trade_performance_log
        └── portfolio_snapshots
```

One IB connection, one set of tables, all trades are paper.

### Target State

```
auto-trader (Node.js)
  ├── paperIb (port 4002, clientId=1) ──→ IB Gateway (paper account)
  ├── liveIb  (port 4001, clientId=2) ──→ IB Gateway (live account)
  └── Supabase
        ├── paper_trades          (unchanged — paper only)
        ├── live_trades           (NEW — identical schema, live only)
        ├── auto_trade_events     (unchanged — paper only)
        ├── live_trade_events     (NEW — identical schema, live only)
        ├── ib_fills              (unchanged — paper only)
        ├── live_ib_fills         (NEW — identical schema, live only)
        ├── strategy_streak_state (unchanged — paper only)
        ├── live_strategy_streak_state (NEW — identical schema, live only)
        ├── trade_performance_log (ADD account_type discriminator)
        └── portfolio_snapshots   (ADD account_type discriminator)
```

### Mode Routing (Initial Configuration)

| TradeMode          | Account  | Rationale                               |
|--------------------|----------|-----------------------------------------|
| `DAY_TRADE`        | **LIVE** | Proven strategy, highest confidence     |
| `SWING_TRADE`      | PAPER    | Still validating hold-period logic      |
| `OPTIONS_PUT`      | PAPER    | Options strategies still maturing       |
| `OPTIONS_CALL`     | PAPER    | Options strategies still maturing       |
| `CALENDAR_SPREAD`  | PAPER    | Options strategies still maturing       |
| `CREDIT_SPREAD`    | PAPER    | Options strategies still maturing       |
| `DAY_PENNY`        | PAPER    | High risk, needs more data              |
| `LONG_TERM`        | PAPER    | Eventually live once validated          |
| `EARNINGS_CALENDAR`| PAPER    | Seasonal, needs more data               |

Routing is configurable via the `auto_trader_config` table (new `mode_routing` JSONB column), changeable at runtime without restart.

### Key Design Decisions

1. **Physical table isolation** for trade-critical data — `paper_trades` and `live_trades` are separate tables. This means zero risk of a query accidentally mixing paper and live trades, and zero changes needed to existing paper-only queries.

2. **Discriminator column** for analytics tables — `trade_performance_log` and `portfolio_snapshots` get an `account_type` column. These tables are append-only analytics with fewer query sites, so a discriminator is lower risk and avoids duplicating complex analytical queries.

3. **One Node.js process, two IB connections** — avoids the operational complexity of running two separate auto-trader processes. Routing is a function call, not inter-process communication.

4. **IB Gateway instances share the same IB user** — IB allows multiple gateway sessions on different ports. Paper on 4002 (existing), live on 4001 (new).

---

## 2. Phase 1: Database Migrations

### Migration File: `supabase/migrations/YYYYMMDD000001_dual_account_tables.sql`

#### 2.1 `live_trades` — Clone of `paper_trades`

```sql
-- Live Trades — identical schema to paper_trades, physically separate for safety.
-- All queries that touch paper_trades do NOT need updating; live_trades has its own query set.

CREATE TABLE live_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN (
      'DAY_TRADE', 'SWING_TRADE', 'LONG_TERM',
      'OPTIONS_PUT', 'OPTIONS_CALL',
      'EARNINGS_CALENDAR', 'CALENDAR_SPREAD', 'CREDIT_SPREAD',
      'DAY_PENNY'
    )),
    signal TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
    strategy_source TEXT,
    strategy_source_url TEXT,
    strategy_video_id TEXT,
    strategy_video_heading TEXT,
    scanner_confidence INT,
    fa_confidence INT,
    fa_recommendation TEXT,
    entry_price NUMERIC,
    stop_loss NUMERIC,
    target_price NUMERIC,
    target_price2 NUMERIC,
    risk_reward TEXT,
    quantity INT,
    position_size NUMERIC,
    ib_order_id TEXT,
    ib_parent_order_id TEXT,
    ib_tp_order_id TEXT,
    ib_sl_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL',
                          'STOPPED', 'TARGET_HIT', 'CLOSED', 'CANCELLED', 'REJECTED')),
    fill_price NUMERIC,
    close_price NUMERIC,
    pnl NUMERIC,
    pnl_percent NUMERIC,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    close_reason TEXT,
    scanner_reason TEXT,
    fa_rationale JSONB,
    notes TEXT,
    in_play_score NUMERIC,
    pass1_confidence INT,
    entry_trigger_type TEXT,
    r_multiple NUMERIC,
    market_condition TEXT,
    pct_distance_sma20_at_entry NUMERIC,
    macd_histogram_slope_at_entry TEXT,
    volume_vs_10d_avg_at_entry NUMERIC,
    regime_alignment_at_entry TEXT,
    price_peak NUMERIC(12,4),
    price_peak_date DATE,
    missing_since TIMESTAMPTZ,
    -- Options fields (from options_wheel / options_auto_trade migrations)
    option_strike NUMERIC,
    option_expiry DATE,
    option_premium NUMERIC,
    option_contracts INT DEFAULT 1,
    option_delta NUMERIC,
    option_iv_rank NUMERIC,
    option_prob_profit NUMERIC,
    option_net_price NUMERIC,
    option_capital_req NUMERIC,
    option_annual_yield NUMERIC,
    option_assigned BOOLEAN DEFAULT FALSE,
    option_close_pct NUMERIC,
    -- Roll tracking (from options_roll_tracking migration)
    roll_count INT NOT NULL DEFAULT 0,
    rolled_from_id UUID,
    -- Spread fields (from credit_spreads migration)
    spread_type TEXT,
    spread_short_strike NUMERIC,
    spread_long_strike NUMERIC,
    spread_width NUMERIC,
    spread_net_credit NUMERIC,
    spread_credit_pct NUMERIC,
    spread_max_loss NUMERIC,
    spread_max_gain NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_trades_status ON live_trades (status);
CREATE INDEX idx_live_trades_ticker ON live_trades (ticker);
CREATE INDEX idx_live_trades_opened ON live_trades (opened_at DESC);
CREATE INDEX idx_live_trades_strategy_source ON live_trades (strategy_source)
  WHERE strategy_source IS NOT NULL;
CREATE INDEX idx_live_trades_rolled_from ON live_trades (rolled_from_id)
  WHERE rolled_from_id IS NOT NULL;
CREATE INDEX idx_live_trades_spread_type ON live_trades (spread_type)
  WHERE spread_type IS NOT NULL;

ALTER TABLE live_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read live trades" ON live_trades FOR SELECT USING (true);
CREATE POLICY "Anyone can insert live trades" ON live_trades FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update live trades" ON live_trades FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete live trades" ON live_trades FOR DELETE USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON live_trades TO anon;
```

#### 2.2 `live_trade_events` — Clone of `auto_trade_events`

```sql
CREATE TABLE live_trade_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('info', 'success', 'warning', 'error')),
    action TEXT,
    source TEXT,
    mode TEXT,
    message TEXT NOT NULL,
    scanner_signal TEXT,
    scanner_confidence INT,
    fa_recommendation TEXT,
    fa_confidence INT,
    skip_reason TEXT,
    strategy_source TEXT,
    strategy_source_url TEXT,
    strategy_video_id TEXT,
    strategy_video_heading TEXT,
    metadata JSONB,
    candle_patterns TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_trade_events_created ON live_trade_events (created_at DESC);
CREATE INDEX idx_live_trade_events_ticker ON live_trade_events (ticker);
CREATE INDEX idx_live_trade_events_action ON live_trade_events (action);

ALTER TABLE live_trade_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read live trade events" ON live_trade_events FOR SELECT USING (true);
CREATE POLICY "Anyone can insert live trade events" ON live_trade_events FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON live_trade_events TO anon;
```

> **Note:** No CHECK constraints on `action`, `source`, or `mode` — following the precedent set by migration `20260514000001` which dropped these constraints from `auto_trade_events` because the app code is the real authority.

#### 2.3 `live_ib_fills` — Clone of `ib_fills`

```sql
CREATE TABLE live_ib_fills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL,
  exec_id text,
  ticker text NOT NULL,
  side text NOT NULL,
  quantity numeric NOT NULL,
  fill_price numeric NOT NULL,
  commission numeric,
  realized_pnl numeric,
  filled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE live_ib_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_live_ib_fills" ON live_ib_fills FOR SELECT USING (true);
CREATE POLICY "insert_live_ib_fills" ON live_ib_fills FOR INSERT WITH CHECK (true);
CREATE POLICY "update_live_ib_fills" ON live_ib_fills FOR UPDATE USING (true);

CREATE INDEX idx_live_ib_fills_order_id ON live_ib_fills(order_id);
CREATE INDEX idx_live_ib_fills_ticker_filled ON live_ib_fills(ticker, filled_at);
```

#### 2.4 `live_strategy_streak_state` — Clone of `strategy_streak_state`

```sql
CREATE TABLE IF NOT EXISTS live_strategy_streak_state (
  mode TEXT PRIMARY KEY,
  is_cold BOOLEAN NOT NULL DEFAULT false,
  entered_cold_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolling_win_rate NUMERIC,
  window_size INT NOT NULL DEFAULT 10
);

ALTER TABLE live_strategy_streak_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read live_strategy_streak_state" ON live_strategy_streak_state FOR SELECT USING (true);
CREATE POLICY "Anyone can insert live_strategy_streak_state" ON live_strategy_streak_state FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update live_strategy_streak_state" ON live_strategy_streak_state FOR UPDATE USING (true);

-- Seed only DAY_TRADE initially (only mode routed to live at launch)
INSERT INTO live_strategy_streak_state (mode, is_cold, window_size)
VALUES ('DAY_TRADE', false, 10)
ON CONFLICT (mode) DO NOTHING;
```

#### 2.5 Analytics Tables — Add `account_type` Discriminator

```sql
-- trade_performance_log: add account_type with default 'paper' (all existing rows are paper)
ALTER TABLE trade_performance_log
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'paper'
    CHECK (account_type IN ('paper', 'live'));

-- Update the unique constraint: trade_id is already unique, but add a composite index
-- for filtered queries
CREATE INDEX IF NOT EXISTS idx_trade_perf_log_account_type
  ON trade_performance_log (account_type);

-- portfolio_snapshots: add account_type with default 'paper'
ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'paper'
    CHECK (account_type IN ('paper', 'live'));

-- Update the unique constraint to include account_type
ALTER TABLE portfolio_snapshots
  DROP CONSTRAINT IF EXISTS portfolio_snapshots_snapshot_date_account_id_key;

ALTER TABLE portfolio_snapshots
  ADD CONSTRAINT portfolio_snapshots_snapshot_date_account_id_account_type_key
    UNIQUE (snapshot_date, account_id, account_type);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account_type
  ON portfolio_snapshots (account_type);
```

#### 2.6 `auto_trader_config` — Add Mode Routing + Kill Switches

```sql
-- Mode routing: maps TradeMode → account_type ('paper' | 'live')
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS mode_routing JSONB NOT NULL DEFAULT '{
    "DAY_TRADE": "live",
    "SWING_TRADE": "paper",
    "OPTIONS_PUT": "paper",
    "OPTIONS_CALL": "paper",
    "CALENDAR_SPREAD": "paper",
    "CREDIT_SPREAD": "paper",
    "DAY_PENNY": "paper",
    "LONG_TERM": "paper",
    "EARNINGS_CALENDAR": "paper"
  }'::jsonb;

-- Global kill switch: halts ALL live trading immediately
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_kill_switch BOOLEAN NOT NULL DEFAULT false;

-- Hard daily loss limit for live account (dollars). If realized P&L
-- on the live account drops below this (negative), halt all live trading
-- for the rest of the day.
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_daily_loss_limit NUMERIC NOT NULL DEFAULT -500;

-- Live account portfolio value (separate from paper portfolioValue)
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_portfolio_value NUMERIC NOT NULL DEFAULT 100000;

-- Live account position sizing overrides (initially conservative)
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_position_size NUMERIC NOT NULL DEFAULT 500;

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_max_positions INT NOT NULL DEFAULT 2;

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_max_daily_deployment NUMERIC NOT NULL DEFAULT 5000;
```

### Config Interface Update

**File:** `shared/config-defaults.ts`

Add to `AutoTraderConfig`:

```typescript
// Dual-account routing
modeRouting: Record<string, 'paper' | 'live'>;
liveKillSwitch: boolean;
liveDailyLossLimit: number;
livePortfolioValue: number;
livePositionSize: number;
liveMaxPositions: number;
liveMaxDailyDeployment: number;
```

Add to `DEFAULT_CONFIG`:

```typescript
modeRouting: {
  DAY_TRADE: 'live',
  SWING_TRADE: 'paper',
  OPTIONS_PUT: 'paper',
  OPTIONS_CALL: 'paper',
  CALENDAR_SPREAD: 'paper',
  CREDIT_SPREAD: 'paper',
  DAY_PENNY: 'paper',
  LONG_TERM: 'paper',
  EARNINGS_CALENDAR: 'paper',
},
liveKillSwitch: false,
liveDailyLossLimit: -500,
livePortfolioValue: 100_000,
livePositionSize: 500,
liveMaxPositions: 2,
liveMaxDailyDeployment: 5_000,
```

### New Shared Type

**File:** `shared/trade-types.ts`

```typescript
export type AccountType = 'paper' | 'live';
```

---

## 3. Phase 2: Auto-Trader Connection Registry

### 3.1 Refactor `ib-connection.ts` → Connection Registry

The current `ib-connection.ts` uses module-level state (single `ib`, `connected`, `nextOrderId`, etc.). Refactor to a class-based `IBConnection` that can be instantiated twice.

**File:** `auto-trader/src/ib-connection.ts`

#### New Class: `IBConnection`

```typescript
import type { AccountType } from '../../shared/trade-types.js';

export class IBConnection {
  readonly label: AccountType;
  readonly port: number;
  readonly clientId: number;

  private ib: IBApi | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private accounts: string[] = [];
  private nextOrderId = 0;
  private connectionListeners: Array<(state: boolean) => void> = [];

  // P&L tracking (per connection)
  private _pnlReqId = 0;
  private _dailyPnL: number | null = null;
  private _unrealizedPnL: number | null = null;
  private _realizedPnL: number | null = null;

  // Fill price cache (per connection)
  private _orderFillPrices = new Map<number, number>();
  private _pendingReqCallbacks = new Map<number, (code: number, msg: string) => void>();
  private _pendingOrderCallbacks = new Map<number, PendingOrder>();

  // Semaphore (per connection)
  private _activeRequests = 0;
  private _requestQueue: Array<() => void> = [];

  constructor(label: AccountType, port: number, clientId: number) {
    this.label = label;
    this.port = port;
    this.clientId = clientId;
  }

  // All existing functions become methods:
  // connect(), isConnected(), getAccounts(), getDefaultAccount(),
  // getIBApi(), getNextOrderId(), getDailyPnL(),
  // placeMarketOrder(), placeBracketOrder(), placeOptionsOrder(),
  // requestPositions(), requestOpenOrders(), cancelOrder(),
  // searchContract(), etc.
  //
  // Log prefix changes from [IB] to [IB:paper] or [IB:live]
}
```

#### Connection Registry (Module-Level)

```typescript
let paperConn: IBConnection | null = null;
let liveConn: IBConnection | null = null;

export function initConnections(): void {
  paperConn = new IBConnection('paper', 4002, 1);
  liveConn = new IBConnection('live', 4001, 2);

  paperConn.connect();
  // Live connection only starts if liveKillSwitch is false
  if (!config.liveKillSwitch) {
    liveConn.connect();
  }
}

export function getPaperConnection(): IBConnection { return paperConn!; }
export function getLiveConnection(): IBConnection { return liveConn!; }

export function getConnectionForAccount(accountType: AccountType): IBConnection {
  return accountType === 'live' ? liveConn! : paperConn!;
}
```

#### Backward Compatibility Layer

To avoid a big-bang rewrite of all callers, keep the existing module-level exports as thin wrappers that delegate to `paperConn`:

```typescript
// Backward compat — these all delegate to paperConn (unchanged behavior)
export function isConnected(): boolean { return paperConn?.isConnected() ?? false; }
export function getAccounts(): string[] { return paperConn?.getAccounts() ?? []; }
export function getDefaultAccount(): string | null { return paperConn?.getDefaultAccount() ?? null; }
export function getIBApi(): IBApi | null { return paperConn?.getIBApi() ?? null; }
export function getNextOrderId(): number { return paperConn?.getNextOrderId() ?? 0; }
export function getDailyPnL(): AccountPnL { return paperConn?.getDailyPnL() ?? { dailyPnL: null, unrealizedPnL: null, realizedPnL: null }; }
// ... etc
```

This means **all existing callers keep working with zero changes** during the transition. New dual-account code uses the class API directly.

### 3.2 Supabase Table Routing

**File:** `auto-trader/src/lib/supabase.ts`

Add table name resolver functions:

```typescript
import type { AccountType } from '../../../shared/trade-types.js';

export function tradesTable(acct: AccountType): 'paper_trades' | 'live_trades' {
  return acct === 'live' ? 'live_trades' : 'paper_trades';
}

export function eventsTable(acct: AccountType): 'auto_trade_events' | 'live_trade_events' {
  return acct === 'live' ? 'live_trade_events' : 'auto_trade_events';
}

export function fillsTable(acct: AccountType): 'ib_fills' | 'live_ib_fills' {
  return acct === 'live' ? 'live_ib_fills' : 'ib_fills';
}

export function streakTable(acct: AccountType): 'strategy_streak_state' | 'live_strategy_streak_state' {
  return acct === 'live' ? 'live_strategy_streak_state' : 'strategy_streak_state';
}
```

All existing Supabase functions (`createPaperTrade`, `updatePaperTrade`, `getActiveTrades`, `createAutoTradeEvent`, `insertIbFill`, etc.) gain an optional `accountType: AccountType = 'paper'` parameter. When `'paper'` (default), they hit the original tables — zero behavior change. When `'live'`, they hit the live tables.

Example:

```typescript
export async function createPaperTrade(
  trade: Partial<PaperTrade>,
  accountType: AccountType = 'paper',
): Promise<PaperTrade> {
  const table = tradesTable(accountType);
  const { data, error } = await supabase
    .from(table)
    .insert(trade)
    .select()
    .single();
  // ...
}
```

### 3.3 IB Fill Routing

The `insertIbFill` and `updateIbFillCommission` functions are called from IB event handlers inside `IBConnection`. Each connection instance knows its `label` (`'paper'` or `'live'`), so it passes that to the Supabase functions:

```typescript
// Inside IBConnection.connect() event handlers:
ib.on(EventName.orderStatus, (orderId, status, filled, _remaining, avgFillPrice) => {
  if (status === 'Filled' && avgFillPrice > 0) {
    insertIbFill({
      order_id: orderId,
      ticker: '',
      side: '',
      quantity: filled,
      fill_price: avgFillPrice,
      filled_at: new Date().toISOString(),
    }, this.label).catch(/* ... */);
  }
});
```

---

## 4. Phase 3: Trade Execution Routing

### 4.1 Mode Router

**New file:** `auto-trader/src/lib/mode-router.ts`

```typescript
import type { TradeMode, AccountType } from '../../../shared/trade-types.js';
import type { AutoTraderConfig } from '../../../shared/config-defaults.js';
import { getConnectionForAccount, type IBConnection } from '../ib-connection.js';

/**
 * Determine which account a trade mode routes to.
 * Reads from config.modeRouting (DB-backed, changeable at runtime).
 * Falls back to 'paper' if the mode is not configured.
 */
export function getAccountForMode(mode: TradeMode, config: AutoTraderConfig): AccountType {
  const routing = config.modeRouting as Record<string, AccountType>;
  return routing[mode] ?? 'paper';
}

/**
 * Get the IB connection for a given trade mode.
 * Throws if live is requested but live connection is down or kill switch is active.
 */
export function getConnectionForMode(
  mode: TradeMode,
  config: AutoTraderConfig,
): { connection: IBConnection; accountType: AccountType } {
  const accountType = getAccountForMode(mode, config);

  if (accountType === 'live') {
    if (config.liveKillSwitch) {
      throw new Error(`Live trading halted: kill switch is active (mode=${mode})`);
    }
    const conn = getConnectionForAccount('live');
    if (!conn.isConnected()) {
      throw new Error(`Live IB connection is down — refusing to route ${mode} to live`);
    }
    return { connection: conn, accountType: 'live' };
  }

  const conn = getConnectionForAccount('paper');
  return { connection: conn, accountType: 'paper' };
}
```

**Critical safety rule:** If `getConnectionForMode` is asked for live but live is disconnected, it does **NOT** fall through to paper. It throws. This prevents accidental paper trades that the user thinks are live.

### 4.2 Scheduler Changes

**File:** `auto-trader/src/scheduler.ts`

The scheduler is the orchestrator — every trade execution path goes through it. Changes needed:

#### A. Import the router

```typescript
import { getConnectionForMode, getAccountForMode } from './lib/mode-router.js';
import type { AccountType } from '../../shared/trade-types.js';
```

#### B. Update `executeScannerTrade()`

Current: calls `placeMarketOrder()` / `placeBracketOrder()` directly (module-level, always paper).

New: resolve the connection via mode router, then call the method on the correct connection.

```typescript
async function executeScannerTrade(scan: ScanResult, mode: TradeMode, config: AutoTraderConfig) {
  const { connection, accountType } = getConnectionForMode(mode, config);

  // ... existing validation, sizing, gates ...

  // Use connection-scoped order placement
  const result = await connection.placeMarketOrder({ symbol, side, quantity });

  // Write to the correct trade table
  await createPaperTrade({ /* ... */ }, accountType);
  await createAutoTradeEvent({ /* ... */ }, accountType);
}
```

#### C. Update all trade execution functions

Each of these functions needs the same pattern (resolve connection → use it → write to correct table):

| Function | Current Connection | New |
|---|---|---|
| `executeScannerTrade()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `executeSuggestedFindTrade()` | module-level `placeBracketOrder` | `connection.placeBracketOrder()` |
| `executeExternalSignalTrade()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `executePennyTrade()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `softCloseDayTrades()` | module-level `placeMarketOrder` | Per-trade: resolve mode → connection |
| `closeAllDayTrades()` | module-level `placeMarketOrder` | Per-trade: resolve mode → connection |
| `checkDipBuyOpportunities()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `checkProfitTakeOpportunities()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `checkLossCutOpportunities()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `checkLongTermAutoSell()` | module-level `placeMarketOrder` | `connection.placeMarketOrder()` |
| `syncPositions()` | module-level `requestPositions` | Per-connection sync |

#### D. Position sync — dual-connection awareness

`syncPositions()` currently calls `requestPositions()` and reconciles against `paper_trades`. It needs to run **twice** — once per connection:

```typescript
async function syncPositions(): Promise<void> {
  // Sync paper positions (existing logic, unchanged)
  const paperPositions = await getPaperConnection().requestPositions();
  await reconcilePositions(paperPositions, 'paper');

  // Sync live positions
  if (getLiveConnection().isConnected()) {
    const livePositions = await getLiveConnection().requestPositions();
    await reconcilePositions(livePositions, 'live');
  }
}

async function reconcilePositions(
  ibPositions: PositionData[],
  accountType: AccountType,
): Promise<void> {
  const activeTrades = await getActiveTrades(accountType);
  // ... existing reconciliation logic, but using accountType-scoped queries
}
```

#### E. P&L tracking — separate per connection

Each `IBConnection` has its own P&L subscription. The scheduler's daily loss check needs to query both:

```typescript
function checkDailyLossLimit(config: AutoTraderConfig): boolean {
  const livePnL = getLiveConnection().getDailyPnL();
  if (livePnL.realizedPnL !== null && livePnL.realizedPnL <= config.liveDailyLossLimit) {
    console.error(`[SAFETY] Live daily loss limit breached: $${livePnL.realizedPnL} <= $${config.liveDailyLossLimit}`);
    return true; // limit breached
  }
  return false;
}
```

#### F. Position sizing — account-specific config

Live account uses `livePositionSize`, `liveMaxPositions`, `liveMaxDailyDeployment` from config. Paper uses existing `positionSize`, `maxPositions`, `maxDailyDeployment`.

```typescript
function getPositionSizeConfig(accountType: AccountType, config: AutoTraderConfig) {
  if (accountType === 'live') {
    return {
      positionSize: config.livePositionSize,
      maxPositions: config.liveMaxPositions,
      maxDailyDeployment: config.liveMaxDailyDeployment,
      portfolioValue: config.livePortfolioValue,
    };
  }
  return {
    positionSize: config.positionSize,
    maxPositions: config.maxPositions,
    maxDailyDeployment: config.maxDailyDeployment,
    portfolioValue: config.portfolioValue,
  };
}
```

#### G. Portfolio snapshots

`savePortfolioSnapshot()` already runs daily. It needs to save separate snapshots for each connected account:

```typescript
// Paper snapshot (existing)
await savePortfolioSnapshot({
  snapshot_date: today,
  account_id: paperConn.getDefaultAccount(),
  account_type: 'paper',
  // ... positions from paperConn.requestPositions()
});

// Live snapshot (new)
if (liveConn.isConnected()) {
  await savePortfolioSnapshot({
    snapshot_date: today,
    account_id: liveConn.getDefaultAccount(),
    account_type: 'live',
    // ... positions from liveConn.requestPositions()
  });
}
```

### 4.3 Trade Performance Logging

**File:** `auto-trader/src/lib/tradePerformanceLog.ts`

`logClosedTradePerformance()` writes to `trade_performance_log`. Add `account_type` to the insert:

```typescript
export async function logClosedTradePerformance(
  trade: PaperTrade,
  accountType: AccountType = 'paper',
): Promise<void> {
  await supabase.from('trade_performance_log').insert({
    trade_id: trade.id,
    ticker: trade.ticker,
    // ... existing fields ...
    account_type: accountType,
  });
}
```

> **Note:** `trade_performance_log.trade_id` has a FK reference to `paper_trades(id)`. For live trades, we need to either:
> (a) Drop the FK and rely on application-level integrity, or
> (b) Add a conditional FK that references `live_trades(id)` when `account_type = 'live'`.
>
> **Recommendation:** Drop the FK. The performance log is append-only analytics. A dangling `trade_id` is annoying but not dangerous. A missing FK is better than complex conditional constraints.

```sql
-- Drop the FK so trade_performance_log can reference both paper_trades and live_trades
ALTER TABLE trade_performance_log DROP CONSTRAINT IF EXISTS trade_performance_log_trade_id_fkey;
```

### 4.4 EOD Reconciliation

**File:** `auto-trader/src/lib/reconcile-executions.ts`

`runEndOfDayReconciliation()` queries `ib_fills` and `paper_trades` to correct fill prices and P&L. It needs to run once per account:

```typescript
export async function runEndOfDayReconciliation(accountType: AccountType = 'paper'): Promise<void> {
  const fills = await supabase.from(fillsTable(accountType)).select('*')...;
  const trades = await supabase.from(tradesTable(accountType)).select('*')...;
  // ... existing reconciliation logic using accountType-scoped tables
}
```

The scheduler calls it twice:

```typescript
await runEndOfDayReconciliation('paper');
if (liveConn.isConnected()) {
  await runEndOfDayReconciliation('live');
}
```

---

## 5. Phase 4: Frontend Account Switcher

### 5.1 Account Context

**New file:** `app/src/contexts/AccountContext.tsx`

```typescript
import { createContext, useContext, useState } from 'react';
import type { AccountType } from '../../../shared/trade-types';

type AccountView = 'live' | 'paper' | 'all';

interface AccountContextValue {
  accountView: AccountView;
  setAccountView: (view: AccountView) => void;
  tradesTable: string;        // 'paper_trades' | 'live_trades'
  eventsTable: string;        // 'auto_trade_events' | 'live_trade_events'
}

const AccountContext = createContext<AccountContextValue>(/* ... */);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [accountView, setAccountView] = useState<AccountView>('live');

  const value: AccountContextValue = {
    accountView,
    setAccountView,
    // For 'all' view, queries need to union both tables
    tradesTable: accountView === 'live' ? 'live_trades' : 'paper_trades',
    eventsTable: accountView === 'live' ? 'live_trade_events' : 'auto_trade_events',
  };

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccountView() {
  return useContext(AccountContext);
}
```

### 5.2 Pill Switcher Component

**In:** `app/src/components/PaperTrading/index.tsx` (top nav area)

```tsx
function AccountPill() {
  const { accountView, setAccountView } = useAccountView();

  return (
    <div className="inline-flex rounded-lg bg-zinc-800 p-0.5 gap-0.5">
      {(['live', 'paper', 'all'] as const).map((view) => (
        <button
          key={view}
          onClick={() => setAccountView(view)}
          className={cn(
            'px-3 py-1 rounded-md text-sm font-medium transition-colors',
            accountView === view
              ? view === 'live'
                ? 'bg-green-600 text-white'
                : view === 'paper'
                ? 'bg-zinc-600 text-white'
                : 'bg-blue-600 text-white'
              : 'text-zinc-400 hover:text-zinc-200',
          )}
        >
          {view === 'live' && '🟢 '}
          {view.charAt(0).toUpperCase() + view.slice(1)}
        </button>
      ))}
    </div>
  );
}
```

### 5.3 Query Routing in `paperTradesApi.ts`

**File:** `app/src/lib/paperTradesApi.ts`

All query functions gain an `accountView` parameter:

```typescript
export async function getAllTrades(accountView: AccountView = 'paper'): Promise<PaperTrade[]> {
  if (accountView === 'all') {
    const [paperResult, liveResult] = await Promise.all([
      supabase.from('paper_trades').select('*').limit(2000),
      supabase.from('live_trades').select('*').limit(2000),
    ]);
    return [
      ...(paperResult.data ?? []).map(t => ({ ...t, _accountType: 'paper' as const })),
      ...(liveResult.data ?? []).map(t => ({ ...t, _accountType: 'live' as const })),
    ].sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
  }

  const table = accountView === 'live' ? 'live_trades' : 'paper_trades';
  const { data, error } = await supabase.from(table).select('*').limit(2000);
  return (data ?? []) as PaperTrade[];
}
```

### 5.4 Stat Cards — Separate P&L Display

**Rule: Never merge live and paper P&L into one number.**

When `accountView === 'all'`, stat cards show:
- Live P&L: green/red card with live-only numbers
- Paper P&L: gray card with paper-only numbers

When `accountView === 'live'` or `'paper'`, show only that account's stats.

### 5.5 Trade Row Badges

In the trades table, each row shows a small badge indicating account:
- 🟢 Green dot for live trades (from `live_trades` or `_accountType === 'live'`)
- Gray dot for paper trades

### 5.6 Files to Change

| File | Change |
|---|---|
| `app/src/components/PaperTrading/index.tsx` | Add `AccountPill` to header, pass `accountView` to data hooks |
| `app/src/lib/paperTradesApi.ts` | All query functions accept `accountView`, route to correct table |
| `app/src/lib/autoTrader.ts` | `getTotalDeployed()` scoped by account |
| `app/src/lib/ibClient.ts` | Add endpoints for live account positions/P&L |
| `app/src/contexts/AccountContext.tsx` | New context for account view state |
| `app/src/App.tsx` | Wrap with `AccountProvider` |
| `app/src/components/PaperTrading/shared/` | Stat cards accept `accountView`, show appropriate data |
| `app/src/components/PaperTrading/tabs/PortfolioTab.tsx` | Filter positions by account |
| `app/src/components/PaperTrading/tabs/TodayActivityTab.tsx` | Query correct events table |
| `app/src/components/PaperTrading/tabs/HistoryTab.tsx` | Query correct trades table |
| `app/src/components/PaperTrading/tabs/PerformanceTab.tsx` | Filter `trade_performance_log` by `account_type` |

---

## 6. Phase 5: Kill Switches & Safety Guards

### 6.1 Global Kill Switch

**Behavior:** When `config.liveKillSwitch === true`:
- `getConnectionForMode()` throws for any mode that resolves to `'live'`
- The live IB connection is gracefully disconnected
- All pending live orders are cancelled
- A CRITICAL event is logged to `live_trade_events`

**Activation paths:**
1. Frontend toggle in Settings tab (writes to `auto_trader_config`)
2. Automatic: triggered by daily loss limit breach
3. Automatic: triggered by live gateway disconnect (doesn't reconnect — requires manual re-enable)

### 6.2 Per-Mode Kill Switch

The `mode_routing` JSONB column serves as the per-mode kill switch. Setting a mode to `'paper'` in the DB immediately routes that mode away from live.

### 6.3 Daily Loss Limit

```typescript
// Checked before every live order placement
function assertLiveLossLimitNotBreached(config: AutoTraderConfig): void {
  const pnl = getLiveConnection().getDailyPnL();
  if (pnl.realizedPnL !== null && pnl.realizedPnL <= config.liveDailyLossLimit) {
    // Auto-engage kill switch
    saveConfigPartial({ liveKillSwitch: true });
    createAutoTradeEvent({
      ticker: 'SYSTEM',
      event_type: 'error',
      message: `Live daily loss limit breached: $${pnl.realizedPnL.toFixed(2)} <= $${config.liveDailyLossLimit}. Kill switch engaged.`,
      action: 'failed',
      source: 'system',
    }, 'live');
    throw new Error('Live daily loss limit breached — kill switch engaged');
  }
}
```

### 6.4 Account Type Validation Before Order Submission

The auto-trader validates `account_type` before every order. This is the final defense:

```typescript
// Inside IBConnection.placeMarketOrder():
placeMarketOrder(params: MarketOrderParams): Promise<MarketOrderResult> {
  // Verify we are on the expected connection
  console.log(`[IB:${this.label}] Market order: ${params.side} ${params.quantity}x ${params.symbol}`);
  // ... existing logic
}
```

### 6.5 Health Monitoring

```typescript
// If live gateway drops, halt live trading immediately
getLiveConnection().onConnectionChange((connected) => {
  if (!connected) {
    console.error('[SAFETY] Live IB connection lost — engaging kill switch');
    saveConfigPartial({ liveKillSwitch: true });
    createAutoTradeEvent({
      ticker: 'SYSTEM',
      event_type: 'error',
      message: 'Live IB Gateway disconnected. Kill switch engaged. Manual re-enable required.',
      action: 'failed',
      source: 'system',
    }, 'live');
  }
});
```

### 6.6 IB-Level Risk Controls (External)

Configure on the live IB account directly (not in our code):
- Max order size
- Max daily trades
- Max position value
- These are a backup safety net — our application-level controls should catch everything first.

### 6.7 Auto-Trader REST Endpoints

**File:** `auto-trader/src/routes/`

New endpoints for frontend kill switch control:

| Endpoint | Method | Action |
|---|---|---|
| `/api/live/kill-switch` | POST | Engage/disengage live kill switch |
| `/api/live/status` | GET | Live connection status, P&L, positions |
| `/api/live/mode-routing` | GET/PUT | Read/update mode routing config |

---

## 7. Phase 6: Testing & Validation

### 7.1 Pre-Launch Checklist

- [ ] **Database:** Run migration, verify all 4 new tables exist with correct schemas
- [ ] **Database:** Verify `account_type` column exists on `trade_performance_log` and `portfolio_snapshots`
- [ ] **Database:** Verify existing data has `account_type = 'paper'` (default)
- [ ] **Database:** Verify RLS policies exist on all new tables
- [ ] **IB Gateway:** Start second gateway instance on port 4001 with live account
- [ ] **IB Gateway:** Verify both gateways can run simultaneously with same IB user
- [ ] **Auto-trader:** Verify `paperConn` connects on port 4002 (unchanged)
- [ ] **Auto-trader:** Verify `liveConn` connects on port 4001
- [ ] **Auto-trader:** Verify both connections show separate `managedAccounts`
- [ ] **Auto-trader:** Verify P&L subscriptions work independently per connection
- [ ] **Auto-trader:** Verify `getConnectionForMode('DAY_TRADE', config)` returns live connection
- [ ] **Auto-trader:** Verify `getConnectionForMode('SWING_TRADE', config)` returns paper connection
- [ ] **Auto-trader:** Verify live kill switch prevents all live orders
- [ ] **Auto-trader:** Verify daily loss limit auto-engages kill switch
- [ ] **Auto-trader:** Verify live gateway disconnect auto-engages kill switch
- [ ] **Auto-trader:** Verify `syncPositions()` reconciles paper and live separately
- [ ] **Auto-trader:** Verify EOD pipeline runs for both accounts
- [ ] **Frontend:** Account pill renders and switches correctly
- [ ] **Frontend:** Live view shows only `live_trades` data
- [ ] **Frontend:** Paper view shows only `paper_trades` data
- [ ] **Frontend:** All view shows both with badges
- [ ] **Frontend:** P&L numbers never mix live and paper
- [ ] **Frontend:** Kill switch toggle in settings works

### 7.2 Safety Scenarios to Test

| Scenario | Expected Behavior |
|---|---|
| Live gateway goes down during trading hours | Kill switch auto-engages, paper continues |
| Live daily P&L hits loss limit | Kill switch auto-engages, paper continues |
| User toggles kill switch ON | All live orders cancelled, live routing throws |
| User toggles kill switch OFF | Live connection restarts, routing resumes |
| Mode routing changed at runtime | Next trade cycle picks up new routing |
| Both gateways down | All trading halted, health check alerts fire |
| DAY_TRADE order placed on live | Writes to `live_trades`, `live_trade_events`, `live_ib_fills` |
| SWING_TRADE order placed on paper | Writes to `paper_trades`, `auto_trade_events`, `ib_fills` |
| EOD close fires for live day trades | Uses live connection to close, updates `live_trades` |
| syncPositions finds orphan on live | Logs CRITICAL error to `live_trade_events`, does NOT close on paper |

### 7.3 Rollback Plan

If live trading needs to be disabled entirely:
1. Set `liveKillSwitch = true` in `auto_trader_config`
2. Set all modes in `mode_routing` to `'paper'`
3. Disconnect live IB Gateway
4. All existing paper logic continues to work unchanged

The physical table separation means paper trading is completely unaffected by any live trading issues.

---

## Implementation Order & Dependencies

```
Phase 1 (DB) ─────────→ Phase 2 (Connection Registry) ──→ Phase 3 (Execution Routing)
                                                                    │
                                                                    ↓
                         Phase 4 (Frontend) ←─────────────── Phase 5 (Kill Switches)
                                                                    │
                                                                    ↓
                                                          Phase 6 (Testing)
```

**Phase 1** can be deployed immediately (additive, no breaking changes).  
**Phases 2–3** are the core auto-trader changes — deploy together.  
**Phase 4** can be developed in parallel with Phases 2–3.  
**Phase 5** is integrated into Phase 2–3 but has its own testing requirements.  
**Phase 6** must pass before any live trading begins.

### Estimated Effort

| Phase | Files Changed | Complexity | Estimate |
|---|---|---|---|
| Phase 1: Database | 1 migration + 1 shared type | Low | 1 session |
| Phase 2: Connection Registry | `ib-connection.ts` + `supabase.ts` | High | 2–3 sessions |
| Phase 3: Execution Routing | `scheduler.ts` + 5–8 lib files | High | 3–4 sessions |
| Phase 4: Frontend | 10–12 component/API files | Medium | 2–3 sessions |
| Phase 5: Kill Switches | Across phases 2–3 + REST routes | Medium | 1–2 sessions |
| Phase 6: Testing | Manual + automated | Medium | 1–2 sessions |

**Total: ~10–15 working sessions**

---

## Files Changed Summary

### New Files
- `supabase/migrations/YYYYMMDD000001_dual_account_tables.sql`
- `auto-trader/src/lib/mode-router.ts`
- `app/src/contexts/AccountContext.tsx`

### Modified Files (Auto-Trader)
- `auto-trader/src/ib-connection.ts` — class-based refactor with dual instances
- `auto-trader/src/lib/supabase.ts` — table routing functions, `accountType` param on all CRUD
- `auto-trader/src/scheduler.ts` — mode routing in all execution functions
- `auto-trader/src/lib/reconcile-executions.ts` — dual-account EOD reconciliation
- `auto-trader/src/lib/tradePerformanceLog.ts` — `account_type` on inserts
- `auto-trader/src/lib/performanceLog.ts` — `account_type` on inserts
- `auto-trader/src/lib/feedback.ts` — `account_type` param
- `auto-trader/src/lib/streak-tracker.ts` — route to correct streak table
- `auto-trader/src/lib/options-scanner.ts` — connection routing
- `auto-trader/src/lib/options-manager.ts` — connection routing
- `auto-trader/src/lib/earnings-scanner.ts` — connection routing
- `auto-trader/src/lib/dip-watcher.ts` — connection routing
- `auto-trader/src/routes/positions.ts` — dual-account position endpoints

### Modified Files (Shared)
- `shared/config-defaults.ts` — new config fields
- `shared/trade-types.ts` — `AccountType` type

### Modified Files (Frontend)
- `app/src/App.tsx` — `AccountProvider` wrapper
- `app/src/components/PaperTrading/index.tsx` — `AccountPill`, pass `accountView`
- `app/src/lib/paperTradesApi.ts` — `accountView` routing on all queries
- `app/src/lib/autoTrader.ts` — account-scoped helpers
- `app/src/lib/ibClient.ts` — live account endpoints
- `app/src/components/PaperTrading/tabs/*.tsx` — account-filtered queries + badges
- `app/src/components/PaperTrading/shared/*.tsx` — account-aware stat cards
