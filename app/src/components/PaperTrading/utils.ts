/** Format a dollar amount with sign before $: +$500, -$718, $0 */
export function fmtUsd(value: number, decimals = 2, showPlus = false): string {
  const sign = value > 0 && showPlus ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(decimals)}`;
}

export function toEtIsoDate(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const year = parts.find(p => p.type === 'year')?.value ?? '0000';
  const month = parts.find(p => p.type === 'month')?.value ?? '00';
  const day = parts.find(p => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

export function formatRegimeLabel(key: string): string {
  const [above, vix] = key.split('_');
  const spy = above === 'above200' ? 'SPY>200' : 'SPY<200';
  const vixLabel = vix === 'panic' ? 'VIX>30' : vix === 'fear' ? 'VIX 25-30' : vix === 'normal' ? 'VIX 15-25' : vix === 'complacent' ? 'VIX<15' : vix;
  return `${spy}, ${vixLabel}`;
}
