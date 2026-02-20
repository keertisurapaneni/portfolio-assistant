/**
 * Unit-test-like examples for InPlayScore (large-cap day trade ranking).
 * Run with: deno test inPlayScore.test.ts
 */

// ── Mock types (mirror trade-scanner) ────────────────────

interface Pass1Indicators {
  rsi14: number | null;
  macdHistogram: number | null;
  sma20: number | null;
  atr14: number | null;
}

interface MockQuote {
  symbol: string;
  regularMarketPrice: number;
  regularMarketChangePercent: number;
  regularMarketVolume: number;
  averageDailyVolume10Day: number;
  regularMarketDayHigh: number;
  regularMarketDayLow: number;
  regularMarketOpen: number;
  regularMarketPreviousClose: number;
  fiftyDayAverage: number;
  twoHundredDayAverage: number;
  _pass1Indicators: Pass1Indicators;
}

function rankToScore(rank: number, total: number): number {
  if (total <= 1) return 10;
  return Math.round(100 * (total - rank) / (total - 1)) / 100;
}

function computeTrendScore(q: MockQuote): number {
  const price = q.regularMarketPrice;
  const sma20 = q._pass1Indicators?.sma20 ?? null;
  const sma50 = q.fiftyDayAverage;
  const sma200 = q.twoHundredDayAverage;
  const macd = q._pass1Indicators?.macdHistogram ?? null;
  const rsi = q._pass1Indicators?.rsi14 ?? null;
  let score = 0;
  if (sma20 != null && price > sma20) score += 2;
  if (sma50 > 0 && price > sma50) score += 2;
  if (sma200 > 0 && price > sma200) score += 2;
  if (macd != null && macd > 0) score += 2;
  if (rsi != null && rsi >= 45 && rsi <= 65) score += 2;
  return Math.min(10, Math.max(0, score));
}

function computeInPlayScore(q: MockQuote, candidates: MockQuote[]): number {
  const price = q.regularMarketPrice;
  const changePct = q.regularMarketChangePercent;
  const volume = q.regularMarketVolume;
  const avgVol = q.averageDailyVolume10Day;
  const high = q.regularMarketDayHigh;
  const low = q.regularMarketDayLow;
  const open = q.regularMarketOpen;
  const prevClose = q.regularMarketPreviousClose;
  const atr14 = q._pass1Indicators?.atr14 ?? null;

  const volRatio = avgVol > 0 ? volume / avgVol : 0;
  const dollarVol = price * volume;
  const atrPct = (price > 0 && atr14 != null && atr14 > 0) ? (atr14 / price) * 100 : 0;
  const extensionPenalty = Math.max(0, Math.abs(changePct) - 3) * 0.7;
  const trendScore = computeTrendScore(q);

  const n = candidates.length;
  const volRatios = candidates.map(c => c.regularMarketVolume / Math.max(1, c.averageDailyVolume10Day));
  const dollarVols = candidates.map(c => c.regularMarketPrice * c.regularMarketVolume);
  const atrPcts = candidates.map(c => {
    const p = c.regularMarketPrice;
    const a = c._pass1Indicators?.atr14 ?? null;
    return (p > 0 && a != null && a > 0) ? (a / p) * 100 : 0;
  });

  const qIdx = candidates.indexOf(q);
  const volRank = volRatios.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).findIndex(x => x.i === qIdx) + 1;
  const dollarRank = dollarVols.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).findIndex(x => x.i === qIdx) + 1;
  const atrRank = atrPcts.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).findIndex(x => x.i === qIdx) + 1;

  const volRatioScore = rankToScore(volRank, n);
  const dollarVolScore = rankToScore(dollarRank, n);
  const atrPctScore = rankToScore(atrRank, n);

  return Math.round(100 * (0.30 * volRatioScore + 0.25 * dollarVolScore + 0.20 * atrPctScore + 0.25 * trendScore - extensionPenalty)) / 100;
}

// ── Mock dataset (6 tickers) ─────────────────────────────

const MOCK_CANDIDATES: MockQuote[] = [
  { symbol: 'NVDA', regularMarketPrice: 138, regularMarketChangePercent: 2.5, regularMarketVolume: 45_000_000, averageDailyVolume10Day: 35_000_000, regularMarketDayHigh: 140, regularMarketDayLow: 135, regularMarketOpen: 136, regularMarketPreviousClose: 134.5, fiftyDayAverage: 130, twoHundredDayAverage: 120, _pass1Indicators: { rsi14: 55, macdHistogram: 0.8, sma20: 132, atr14: 4.2 } },
  { symbol: 'TSLA', regularMarketPrice: 245, regularMarketChangePercent: -1.2, regularMarketVolume: 120_000_000, averageDailyVolume10Day: 90_000_000, regularMarketDayHigh: 250, regularMarketDayLow: 242, regularMarketOpen: 248, regularMarketPreviousClose: 248, fiftyDayAverage: 240, twoHundredDayAverage: 220, _pass1Indicators: { rsi14: 48, macdHistogram: -0.3, sma20: 244, atr14: 8.5 } },
  { symbol: 'AAPL', regularMarketPrice: 185, regularMarketChangePercent: 0.8, regularMarketVolume: 55_000_000, averageDailyVolume10Day: 50_000_000, regularMarketDayHigh: 186, regularMarketDayLow: 183, regularMarketOpen: 184, regularMarketPreviousClose: 183.5, fiftyDayAverage: 182, twoHundredDayAverage: 175, _pass1Indicators: { rsi14: 52, macdHistogram: 0.2, sma20: 184, atr14: 2.1 } },
  { symbol: 'META', regularMarketPrice: 520, regularMarketChangePercent: 5.5, regularMarketVolume: 18_000_000, averageDailyVolume10Day: 12_000_000, regularMarketDayHigh: 525, regularMarketDayLow: 510, regularMarketOpen: 512, regularMarketPreviousClose: 493, fiftyDayAverage: 480, twoHundredDayAverage: 450, _pass1Indicators: { rsi14: 68, macdHistogram: 2.1, sma20: 500, atr14: 15 } },
  { symbol: 'AMD', regularMarketPrice: 142, regularMarketChangePercent: 3.2, regularMarketVolume: 65_000_000, averageDailyVolume10Day: 55_000_000, regularMarketDayHigh: 145, regularMarketDayLow: 139, regularMarketOpen: 140, regularMarketPreviousClose: 137.6, fiftyDayAverage: 135, twoHundredDayAverage: 125, _pass1Indicators: { rsi14: 58, macdHistogram: 0.5, sma20: 138, atr14: 4.8 } },
  { symbol: 'MSFT', regularMarketPrice: 415, regularMarketChangePercent: 0.5, regularMarketVolume: 22_000_000, averageDailyVolume10Day: 25_000_000, regularMarketDayHigh: 416, regularMarketDayLow: 413, regularMarketOpen: 414, regularMarketPreviousClose: 413, fiftyDayAverage: 410, twoHundredDayAverage: 395, _pass1Indicators: { rsi14: 50, macdHistogram: 0.1, sma20: 412, atr14: 3.2 } },
];

// ── Run and print ────────────────────────────────────────

const scored = MOCK_CANDIDATES.map(q => ({
  symbol: q.symbol,
  inPlayScore: computeInPlayScore(q, MOCK_CANDIDATES),
  volRatio: (q.regularMarketVolume / Math.max(1, q.averageDailyVolume10Day)).toFixed(2),
  dollarVolB: ((q.regularMarketPrice * q.regularMarketVolume) / 1e9).toFixed(2),
  atrPct: ((q._pass1Indicators?.atr14 ?? 0) / q.regularMarketPrice * 100).toFixed(2),
}));
scored.sort((a, b) => b.inPlayScore - a.inPlayScore);

console.log('InPlayScore ordering (top first):');
scored.forEach((s, i) => {
  const q = MOCK_CANDIDATES.find(w => w.symbol === s.symbol)!;
  const extPen = Math.max(0, Math.abs(q.regularMarketChangePercent) - 3) * 0.7;
  console.log(`  ${i + 1}. ${s.symbol}: ${s.inPlayScore} (extPen=${extPen.toFixed(2)}) | volRatio=${s.volRatio} $Vol=${s.dollarVolB}B atrPct=${s.atrPct}%`);
});

// Weights: 0.30 volRatio + 0.25 dollarVol + 0.20 atrPct + 0.25 trendScore - extensionPenalty
// extensionPenalty = max(0, abs(changePct) - 3) * 0.7
