export { fmtUsd } from '../../../../shared/format.ts';
export { toEtIsoDate } from '../../../../shared/date-helpers.ts';

export function formatRegimeLabel(key: string): string {
  const [above, vix] = key.split('_');
  const spy = above === 'above200' ? 'SPY>200' : 'SPY<200';
  const vixLabel = vix === 'panic' ? 'VIX>30' : vix === 'fear' ? 'VIX 25-30' : vix === 'normal' ? 'VIX 15-25' : vix === 'complacent' ? 'VIX<15' : vix;
  return `${spy}, ${vixLabel}`;
}
