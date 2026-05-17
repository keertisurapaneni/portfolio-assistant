/**
 * Mode-based routing for dual-account trade execution.
 *
 * Determines which IB connection (paper vs live) a trade should use,
 * based on the trade's mode and the runtime config.modeRouting map.
 *
 * Safety: if live is requested but the connection is down or the kill
 * switch is active, this module THROWS — it never silently falls through
 * to paper. Callers must catch and handle the error explicitly.
 */

import type { TradeMode, AccountType } from '../../../shared/trade-types.js';
import type { AutoTraderConfig } from '../../../shared/config-defaults.js';
import { getConnectionForAccount, getLiveConnection, type IBConnection } from '../ib-connection.js';
import { saveConfigPartial, createAutoTradeEvent } from './supabase.js';

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
