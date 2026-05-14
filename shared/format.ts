/**
 * Shared formatting helpers — Single Source of Truth
 *
 * Currency and number formatting. Pure functions, no runtime deps.
 */

/**
 * Format a dollar amount with sign before $: +$500, -$718, $0.
 * Handles negative values correctly (never produces "$-718").
 */
export function fmtUsd(value: number, decimals = 2, showPlus = false): string {
  const sign = value > 0 && showPlus ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(decimals)}`;
}

/** Compact USD format for log messages: +$500, -$718 (always shows sign, 0 decimals) */
export function fmtUsdCompact(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(0)}`;
}
