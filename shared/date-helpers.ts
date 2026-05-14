/**
 * Shared ET (Eastern Time) date/time helpers — Single Source of Truth
 *
 * Pure functions for US market time operations.
 * No runtime dependencies — works in Node, browser, and Deno.
 */

export interface ETTime {
  hour: number;
  minute: number;
  dayOfWeek: number; // 0=Sun, 6=Sat
}

/** Get current time in US Eastern (handles DST automatically). */
export function getETNow(now?: Date): ETTime {
  const d = now ?? new Date();
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hour: et.getHours(), minute: et.getMinutes(), dayOfWeek: et.getDay() };
}

/** Get today's date as YYYY-MM-DD in US Eastern. */
export function getETDateString(now?: Date): string {
  return formatDateToEtIso(now ?? new Date());
}

/** Format any Date to YYYY-MM-DD in US Eastern. */
export function formatDateToEtIso(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find(p => p.type === 'year')?.value ?? '0000';
  const month = parts.find(p => p.type === 'month')?.value ?? '00';
  const day = parts.find(p => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

/**
 * Parse a timestamp string to ET ISO date (YYYY-MM-DD).
 * Returns null for empty/invalid input. Passes through if already YYYY-MM-DD.
 */
export function toEtIsoDate(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateToEtIso(parsed);
}

/**
 * True during US regular trading hours: 9:30 AM – 4:00 PM ET, Mon–Fri.
 * Does NOT account for market holidays.
 */
export function isMarketOpen(now?: Date): boolean {
  const { hour, minute, dayOfWeek } = getETNow(now);
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 570 && mins < 960; // 9:30=570, 16:00=960
}
