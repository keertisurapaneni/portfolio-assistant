/**
 * Mode-based routing for dual-account trade execution.
 *
 * Determines which IB connection(s) (paper / live / both) a trade should use,
 * based on the trade's mode and the runtime config.modeRouting map.
 *
 * Routing states:
 *   'off'   → throws (mode is disabled, caller should skip)
 *   'paper' → single paper connection
 *   'live'  → single live connection (kill-switch / connectivity enforced)
 *   'both'  → paper always first, then live (best-effort — warns if live is down)
 *
 * Safety: if live is requested but the connection is down or the kill
 * switch is active, this module THROWS for 'live' and WARNS for 'both'.
 */

import type { TradeMode, AccountType, RouteTarget } from '../../../shared/trade-types.js';
import type { AutoTraderConfig } from '../../../shared/config-defaults.js';
import { getConnectionForAccount, getLiveConnection, type IBConnection } from '../ib-connection.js';
import { saveConfigPartial, createAutoTradeEvent } from './supabase.js';

export interface RoutedConnection {
  connection: IBConnection;
  accountType: AccountType;
}

/**
 * Determine the routing target for a trade mode.
 * Falls back to 'paper' if the mode is not configured.
 */
export function getRouteTarget(mode: TradeMode, config: AutoTraderConfig): RouteTarget {
  return (config.modeRouting as Record<string, RouteTarget>)[mode] ?? 'paper';
}

/** Backward-compat alias — returns the primary account type ('paper' or 'live'). */
export function getAccountForMode(mode: TradeMode, config: AutoTraderConfig): AccountType {
  const target = getRouteTarget(mode, config);
  if (target === 'off') return 'paper';
  if (target === 'both') return 'paper';
  return target;
}

/** Returns true if a mode has any routing target other than 'off'. */
export function isModeEnabled(config: AutoTraderConfig, mode: TradeMode): boolean {
  return getRouteTarget(mode, config) !== 'off';
}

function resolveLiveConnection(mode: TradeMode, config: AutoTraderConfig): RoutedConnection | null {
  if (config.liveKillSwitch) return null;
  const conn = getConnectionForAccount('live');
  if (!conn.isConnected()) return null;
  return { connection: conn, accountType: 'live' };
}

/**
 * Get the IB connection(s) for a given trade mode.
 *
 * Returns an array of connections to execute against. For 'both' mode,
 * paper is always first (guaranteed), live is appended if available.
 *
 * Throws for 'off' (mode disabled) and 'live' when live is unavailable.
 */
export function getConnectionForMode(
  mode: TradeMode,
  config: AutoTraderConfig,
): { connections: RoutedConnection[] } {
  const target = getRouteTarget(mode, config);

  if (target === 'off') {
    throw new Error(`Mode ${mode} is disabled (routing=off)`);
  }

  if (target === 'paper') {
    const conn = getConnectionForAccount('paper');
    return { connections: [{ connection: conn, accountType: 'paper' }] };
  }

  if (target === 'live') {
    if (config.liveKillSwitch) {
      throw new Error(`Live trading halted: kill switch is active (mode=${mode})`);
    }
    const conn = getConnectionForAccount('live');
    if (!conn.isConnected()) {
      throw new Error(`Live IB connection is down — refusing to route ${mode} to live`);
    }
    return { connections: [{ connection: conn, accountType: 'live' }] };
  }

  // 'both' — paper always, live best-effort
  const paperConn = getConnectionForAccount('paper');
  const connections: RoutedConnection[] = [{ connection: paperConn, accountType: 'paper' }];

  const live = resolveLiveConnection(mode, config);
  if (live) {
    connections.push(live);
  } else {
    const reason = config.liveKillSwitch ? 'kill switch active' : 'live connection down';
    console.warn(`[ModeRouter] ${mode} routed to 'both' but live unavailable (${reason}) — paper only`);
  }

  return { connections };
}

/**
 * Get position sizing configuration for an account type.
 * Live uses conservative overrides; paper uses the standard config values.
 */
export function getPositionSizeConfig(accountType: AccountType, config: AutoTraderConfig) {
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

/**
 * Assert that the live daily loss limit has not been breached.
 * If breached, auto-engages the kill switch and throws.
 * Call this before every live order placement.
 */
export async function assertLiveLossLimitNotBreached(config: AutoTraderConfig): Promise<void> {
  const livePnL = getLiveConnection().getDailyPnL();
  if (livePnL.realizedPnL !== null && livePnL.realizedPnL <= config.liveDailyLossLimit) {
    await saveConfigPartial({ live_kill_switch: true });
    await createAutoTradeEvent({
      ticker: 'SYSTEM',
      event_type: 'error',
      message: `Live daily loss limit breached: $${livePnL.realizedPnL.toFixed(2)} <= $${config.liveDailyLossLimit}. Kill switch engaged.`,
      action: 'failed',
      source: 'system',
    }, 'live').catch(() => {});
    throw new Error(`Live daily loss limit breached ($${livePnL.realizedPnL.toFixed(2)} <= $${config.liveDailyLossLimit}) — kill switch engaged`);
  }
}
