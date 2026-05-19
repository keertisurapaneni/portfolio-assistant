/**
 * Options chain data fetcher via IB Gateway.
 *
 * Fetches available strikes/expiries for a stock, then requests
 * live Greeks (delta, IV, theta) for candidate put strikes.
 *
 * Flow:
 *   1. getConId(symbol)           → underlying contract ID
 *   2. getOptionParams(conId)     → available expirations + strikes
 *   3. getOptionGreeks(contract)  → live delta, IV, theta for one strike
 *   4. findBestPutStrike(...)     → picks the 20-25 delta strike
 */

import { EventName, SecType, OptionType, type Contract } from '@stoqey/ib';
import { getIBApi, getNextOrderId, isConnected, searchContract, acquireRequestSlot, releaseRequestSlot, registerReqErrorCallback, unregisterReqErrorCallback } from '../ib-connection.js';
import { estimateHistoricalVol } from './yahoo-finance.js';

// ── Types ────────────────────────────────────────────────

export interface OptionGreeks {
  strike: number;
  expiry: string;         // YYYYMMDD
  optionType: 'P' | 'C';
  bid: number;
  ask: number;
  mid: number;            // (bid+ask)/2 — realistic fill price
  impliedVol: number;     // as decimal e.g. 0.35 = 35%
  delta: number;          // negative for puts e.g. -0.22
  theta: number;          // daily decay
  gamma: number;
  vega: number;
  probProfit: number;     // % probability of expiring OTM (abs(delta) subtracted from 1)
  annualYield: number;    // (mid / strike) * (365 / daysToExpiry) * 100
}

export interface OptionsChainSummary {
  symbol: string;
  underlyingPrice: number;
  ivRank: number | null;   // null if no history yet; populated from DB over time
  currentIV: number;       // ATM put IV
  bestPut: OptionGreeks | null;
  bestCall: OptionGreeks | null;
  expirations: string[];   // available expiry dates YYYYMMDD
}

// ── Black-Scholes Synthetic Chain (IB-free fallback) ─────

/** Abramowitz & Stegun approximation — accurate to ~7 decimal places */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - t * Math.exp(-ax * ax) *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * (1 + sign * y);
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

interface BSResult { price: number; delta: number; gamma: number; theta: number; vega: number }

/**
 * Black-Scholes European put.
 * @param S stock price  @param K strike  @param T years to expiry
 * @param r risk-free rate  @param v implied vol (decimal)
 */
function bsPut(S: number, K: number, T: number, r: number, v: number): BSResult {
  if (T <= 0) return { price: Math.max(K - S, 0), delta: -1, gamma: 0, theta: 0, vega: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const price = K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  const delta = normCdf(d1) - 1;                          // negative for puts
  const gamma = normPdf(d1) / (S * v * sqrtT);
  const theta = (-(S * normPdf(d1) * v) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCdf(-d2)) / -365;
  const vega  = S * normPdf(d1) * sqrtT / 100;
  return { price, delta, gamma, theta, vega };
}

/** Third Friday of each month for the next `count` months, as YYYYMMDD strings. */
function getMonthlyExpiries(count = 4): string[] {
  const expiries: string[] = [];
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  while (expiries.length < count) {
    const firstDay = new Date(year, month, 1);
    let friday = 1 + ((5 - firstDay.getDay() + 7) % 7); // first Friday
    friday += 14;                                          // third Friday
    const expiry = new Date(year, month, friday);
    const dte = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
    if (dte > 7) {
      const mm = String(month + 1).padStart(2, '0');
      const dd = String(friday).padStart(2, '0');
      expiries.push(`${year}${mm}${dd}`);
    }
    if (++month > 11) { month = 0; year++; }
  }
  return expiries;
}

/** Realistic option strike intervals by price tier. */
function generateStrikes(price: number): number[] {
  const interval = price < 25 ? 1 : price < 200 ? 2.5 : 5;
  const low  = Math.floor(price * 0.70 / interval) * interval;
  const high = Math.ceil(price / interval) * interval;
  const out: number[] = [];
  for (let s = high; s >= low; s -= interval) out.push(Math.round(s * 100) / 100);
  return out; // descending: near-ATM → far OTM (delta -0.5 → 0)
}

/**
 * Estimate annualised IV from 30-day realised volatility via Yahoo Finance.
 * Delegates to the shared yahoo-finance module (no Finnhub dependency).
 */
async function estimateIV(symbol: string): Promise<number> {
  return estimateHistoricalVol(symbol);
}

/**
 * Build a synthetic options chain using Black-Scholes when IB is unavailable.
 * IV is estimated from 30-day realised volatility via Yahoo Finance.
 */
async function getSyntheticOptionsChain(
  symbol: string,
  underlyingPrice: number,
  deltaTarget = 0.22,
  dteDays?: number,
  constraints?: ExpiryConstraints,
): Promise<OptionsChainSummary | null> {
  const iv       = await estimateIV(symbol);
  const expiries = getMonthlyExpiries(4);
  const expiry   = dteDays
    ? pickBestExpiryForDte(expiries, dteDays, constraints?.avoidWeeks, constraints?.earningsBefore)
    : pickBestExpiry(expiries, constraints?.avoidWeeks, constraints?.earningsBefore);
  if (!expiry) return null;

  const dte = daysToExpiry(expiry);
  const T   = dte / 365;
  const r   = 0.05;

  const deltaLow  = Math.max(0.10, deltaTarget - 0.07);
  const deltaHigh = deltaTarget + 0.07;
  const strikes   = generateStrikes(underlyingPrice);

  let bestPut: OptionGreeks | null = null;
  let closestDeltaErr = Infinity;
  let closestPut: OptionGreeks | null = null;

  for (const strike of strikes) {
    if (strike >= underlyingPrice * 0.99) continue; // OTM only
    const bs      = bsPut(underlyingPrice, strike, T, r, iv);
    const absDelta = Math.abs(bs.delta);
    const spread  = Math.max(bs.price * 0.05, 0.02); // synthetic 5% spread
    const bid     = Math.max(bs.price - spread / 2, 0.01);
    const ask     = bs.price + spread / 2;
    const annualYield = dte > 0 ? (bid / strike) * (365 / dte) * 100 : 0;

    const greeks: OptionGreeks = {
      strike, expiry, optionType: 'P',
      bid, ask, mid: bs.price,
      impliedVol: iv,
      delta: bs.delta, theta: bs.theta, gamma: bs.gamma, vega: bs.vega,
      probProfit: (1 - absDelta) * 100,
      annualYield,
    };

    if (absDelta >= deltaLow && absDelta <= deltaHigh && !bestPut) {
      bestPut = greeks;
    }

    const err = Math.abs(absDelta - deltaTarget);
    if (err < closestDeltaErr) { closestDeltaErr = err; closestPut = greeks; }
  }

  return {
    symbol, underlyingPrice,
    ivRank: null,
    currentIV: iv,
    bestPut: bestPut ?? closestPut,
    bestCall: null,
    expirations: expiries,
  };
}

// ── Helpers ──────────────────────────────────────────────

function daysToExpiry(expiryYYYYMMDD: string): number {
  const y = parseInt(expiryYYYYMMDD.slice(0, 4), 10);
  const m = parseInt(expiryYYYYMMDD.slice(4, 6), 10) - 1;
  const d = parseInt(expiryYYYYMMDD.slice(6, 8), 10);
  const exp = new Date(y, m, d);
  const now = new Date();
  return Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function pickBestExpiry(expirations: string[], avoidWeeks?: Set<string>, earningsBefore?: string): string | null {
  // Target 30–45 DTE for optimal theta decay (sweet spot per Brad Castro / OptionsPlay).
  // Minimum 21 DTE — if the nearest monthly is < 21 DTE, roll to the next monthly.
  // If earningsBefore is set (YYYYMMDD), skip expiries that fall on or after earnings.
  // If avoidWeeks is set, prefer expiries in non-crowded weeks (still allow as last resort).
  const valid = expirations
    .map(e => ({ e, dte: daysToExpiry(e), wk: expiryYYYYMMDDtoWeekKey(e) }))
    .filter(x => x.dte >= 21)
    .filter(x => !earningsBefore || x.e < earningsBefore);

  if (valid.length === 0) {
    const relaxed = expirations
      .map(e => ({ e, dte: daysToExpiry(e) }))
      .filter(x => x.dte >= 14)
      .sort((a, b) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38));
    return relaxed[0]?.e ?? null;
  }

  const preferred = avoidWeeks?.size
    ? valid.filter(x => !avoidWeeks.has(x.wk))
    : valid;
  const pool = preferred.length > 0 ? preferred : valid;
  pool.sort((a, b) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38));
  return pool[0]?.e ?? null;
}

/** Pick expiry closest to a specific DTE target (e.g. 21 for bear mode). */
function pickBestExpiryForDte(expirations: string[], targetDte: number, avoidWeeks?: Set<string>, earningsBefore?: string): string | null {
  const minDte = Math.max(7, targetDte - 10);
  const maxDte = targetDte + 14;
  let candidates = expirations
    .map(e => ({ e, dte: daysToExpiry(e), wk: expiryYYYYMMDDtoWeekKey(e) }))
    .filter(x => x.dte >= minDte && x.dte <= maxDte)
    .filter(x => !earningsBefore || x.e < earningsBefore);

  if (candidates.length === 0) {
    candidates = expirations
      .map(e => ({ e, dte: daysToExpiry(e), wk: expiryYYYYMMDDtoWeekKey(e) }))
      .filter(x => x.dte >= minDte && x.dte <= maxDte);
  }

  const preferred = avoidWeeks?.size
    ? candidates.filter(x => !avoidWeeks.has(x.wk))
    : candidates;
  const pool = preferred.length > 0 ? preferred : candidates;
  pool.sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  return pool[0]?.e ?? null;
}

// ── Get Option Chain Parameters ───────────────────────────

interface OptionParams {
  expirations: string[];
  strikes: number[];
  multiplier: string;
  tradingClass: string;
}

async function getOptionChainParams(conId: number, symbol: string): Promise<OptionParams | null> {
  const ib = getIBApi();
  if (!ib || !isConnected()) return null;

  await acquireRequestSlot();
  try {
    return await new Promise<OptionParams | null>((resolve) => {
      const reqId = getNextOrderId();
      const emitter = ib as unknown as NodeJS.EventEmitter;
      let resolved = false;
      const allParams: OptionParams[] = [];

      const finish = (result: OptionParams | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        unregisterReqErrorCallback(reqId);
        emitter.off(EventName.securityDefinitionOptionParameter, paramHandler);
        emitter.off(EventName.securityDefinitionOptionParameterEnd, endHandler);
        resolve(result);
      };

      const timeout = setTimeout(() => finish(allParams[0] ?? null), 15_000);

      registerReqErrorCallback(reqId, () => finish(null));

      const paramHandler = (rId: number, exchange: string, _conId: number, tradingClass: string, multiplier: string, expirations: string[], strikes: number[]) => {
        if (rId !== reqId) return;
        if (exchange === 'SMART' || allParams.length === 0) {
          allParams.unshift({ expirations: Array.from(expirations).sort(), strikes: Array.from(strikes).sort((a, b) => a - b), multiplier, tradingClass });
        } else {
          allParams.push({ expirations: Array.from(expirations).sort(), strikes: Array.from(strikes).sort((a, b) => a - b), multiplier, tradingClass });
        }
      };

      const endHandler = (rId: number) => {
        if (rId !== reqId || resolved) return;
        finish(allParams[0] ?? null);
      };

      emitter.on(EventName.securityDefinitionOptionParameter, paramHandler);
      emitter.on(EventName.securityDefinitionOptionParameterEnd, endHandler);

      (ib as unknown as { reqSecDefOptParams: (reqId: number, symbol: string, exchange: string, secType: string, conId: number) => void })
        .reqSecDefOptParams(reqId, symbol.toUpperCase(), '', 'STK', conId);
    });
  } finally {
    releaseRequestSlot();
  }
}

// ── Get Greeks for a Specific Option Contract ─────────────

async function getOptionGreeksForContract(
  symbol: string,
  strike: number,
  expiry: string,
  optionType: 'P' | 'C',
  underlyingPrice: number,
): Promise<OptionGreeks | null> {
  const ib = getIBApi();
  if (!ib || !isConnected()) return null;

  await acquireRequestSlot();
  try {
    return await new Promise<OptionGreeks | null>((resolve) => {
      const reqId = getNextOrderId();
      const emitter = ib as unknown as NodeJS.EventEmitter;
      let resolved = false;
      let bidPrice = -1, askPrice = -1;
      let impliedVol = 0, delta = 0, theta = 0, gamma = 0, vega = 0;

      const contract: Contract = {
        symbol: symbol.toUpperCase(),
        secType: SecType.OPT,
        exchange: 'SMART',
        currency: 'USD',
        strike,
        right: optionType === 'P' ? OptionType.Put : OptionType.Call,
        lastTradeDateOrContractMonth: expiry,
        multiplier: 100,
        tradingClass: symbol.toUpperCase(),
      };

      function finish(result: OptionGreeks | null) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        unregisterReqErrorCallback(reqId);
        emitter.off(EventName.tickOptionComputation, greeksHandler);
        emitter.off(EventName.tickPrice, priceHandler);
        emitter.off(EventName.error, errorHandler);
        try { (ib as unknown as { cancelMktData: (id: number) => void }).cancelMktData(reqId); } catch { /* ignore */ }
        resolve(result);
      }

      function buildResult(): OptionGreeks {
        const mid = bidPrice >= 0 && askPrice >= 0 ? (bidPrice + askPrice) / 2 : Math.max(bidPrice, askPrice, 0);
        const realisticMid = Math.max(mid - 0.05, 0.01);
        const dte = daysToExpiry(expiry);
        const annualYield = dte > 0 ? (realisticMid / strike) * (365 / dte) * 100 : 0;
        const absDelta = Math.abs(delta);
        const probProfit = (1 - absDelta) * 100;

        return {
          strike, expiry,
          optionType,
          bid: bidPrice >= 0 ? bidPrice : 0,
          ask: askPrice >= 0 ? askPrice : 0,
          mid: realisticMid,
          impliedVol,
          delta,
          theta,
          gamma,
          vega,
          probProfit,
          annualYield,
        };
      }

      const timeout = setTimeout(() => {
        if (impliedVol > 0 && delta !== 0) {
          finish(buildResult());
        } else {
          finish(null);
        }
      }, 12_000);

      // Centralized per-request error routing (handles code 200 "no security definition")
      registerReqErrorCallback(reqId, () => finish(null));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const greeksHandler = (tickerId: number, _tickType: number, _tickAttrib: number, iv: number, d: number, _optPrice: number, _pvDiv: number, g: number, v: number, t: number, _undPrice: number) => {
        if (tickerId !== reqId) return;
        if (iv && iv > 0 && iv < 5) impliedVol = iv;
        if (d && d !== 0 && Math.abs(d) <= 1) delta = d;
        if (t && t !== 0) theta = t;
        if (g && g !== 0) gamma = g;
        if (v && v !== 0) vega = v;

        if (!resolved && impliedVol > 0 && delta !== 0 && bidPrice >= 0 && askPrice >= 0) {
          finish(buildResult());
        }
      };

      const priceHandler = (tickerId: number, tickType: number, price: number) => {
        if (tickerId !== reqId) return;
        if (tickType === 1) bidPrice = price;
        if (tickType === 2) askPrice = price;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorHandler = (_err: any, code: number, id: number) => {
        if (id !== reqId) return;
        // 200 = no security definition, 354 = not subscribed, 10091 = needs subscription
        if ((code === 200 || code === 354 || code === 10091) && !resolved) {
          finish(null);
        }
      };

      emitter.on(EventName.tickOptionComputation, greeksHandler);
      emitter.on(EventName.tickPrice, priceHandler);
      emitter.on(EventName.error, errorHandler);

      (ib as unknown as { reqMktData: (id: number, c: Contract, genericTicks: string, snapshot: boolean, regulatory: boolean, options: unknown[]) => void })
        .reqMktData(reqId, contract, '', false, false, []);
    });
  } finally {
    releaseRequestSlot();
  }
}

// ── Find Best Put Strike ──────────────────────────────────

/**
 * @param deltaTarget  Desired absolute delta (e.g. 0.20 = 20-delta, 0.15 = 15-delta bear mode)
 */
async function findBestPutStrike(
  symbol: string,
  strikes: number[],
  expiry: string,
  underlyingPrice: number,
  deltaTarget = 0.22,
): Promise<OptionGreeks | null> {
  // Target delta band: ±0.07 around the target
  const deltaLow = Math.max(0.10, deltaTarget - 0.07);
  const deltaHigh = deltaTarget + 0.07;

  // Estimate target strike: delta maps roughly to OTM distance
  const targetPct = deltaTarget < 0.18 ? 0.12 : 0.10;
  const targetStrike = underlyingPrice * (1 - targetPct);

  const candidates = strikes
    .filter(s => s < underlyingPrice * 0.98)
    .sort((a, b) => Math.abs(a - targetStrike) - Math.abs(b - targetStrike))
    .slice(0, 6);

  for (const strike of candidates) {
    const greeks = await getOptionGreeksForContract(symbol, strike, expiry, 'P', underlyingPrice);
    if (!greeks) continue;
    const absDelta = Math.abs(greeks.delta);
    if (absDelta >= deltaLow && absDelta <= deltaHigh) return greeks;
  }

  // Fallback: return first candidate that returned greeks
  for (const strike of candidates) {
    const greeks = await getOptionGreeksForContract(symbol, strike, expiry, 'P', underlyingPrice);
    if (greeks) return greeks;
  }

  return null;
}

/**
 * Find the best OTM call strike for covered call writing, using delta targeting.
 * Mirrors findBestPutStrike logic but for the call side.
 */
async function findBestCallStrike(
  symbol: string,
  strikes: number[],
  expiry: string,
  underlyingPrice: number,
  deltaTarget = 0.20,
): Promise<OptionGreeks | null> {
  const deltaLow = Math.max(0.10, deltaTarget - 0.07);
  const deltaHigh = deltaTarget + 0.07;

  const targetPct = deltaTarget < 0.18 ? 0.08 : 0.06;
  const targetStrike = underlyingPrice * (1 + targetPct);

  const candidates = strikes
    .filter(s => s > underlyingPrice * 1.02)
    .sort((a, b) => Math.abs(a - targetStrike) - Math.abs(b - targetStrike))
    .slice(0, 6);

  for (const strike of candidates) {
    const greeks = await getOptionGreeksForContract(symbol, strike, expiry, 'C', underlyingPrice);
    if (!greeks) continue;
    const absDelta = Math.abs(greeks.delta);
    if (absDelta >= deltaLow && absDelta <= deltaHigh) return greeks;
  }

  for (const strike of candidates) {
    const greeks = await getOptionGreeksForContract(symbol, strike, expiry, 'C', underlyingPrice);
    if (greeks) return greeks;
  }

  return null;
}

// ── Main Export ──────────────────────────────────────────

/**
 * Get the full options chain summary for a stock.
 * Uses live IB data when connected; falls back to a Black-Scholes synthetic
 * chain (Finnhub HV-derived IV) so the scanner can run without IB Gateway.
 */
export interface ExpiryConstraints {
  avoidWeeks?: Set<string>;     // ISO week keys (YYYY-MM-DD Monday) with too many positions
  earningsBefore?: string;      // YYYYMMDD — don't pick expiries on or after this date
}

function expiryYYYYMMDDtoWeekKey(yyyymmdd: string): string {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const date = new Date(y, m, d);
  const day = date.getUTCDay();
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export async function getOptionsChain(
  symbol: string,
  underlyingPrice: number,
  storedIvRank: number | null = null,
  deltaTarget?: number,
  dteDays?: number,
  constraints?: ExpiryConstraints,
): Promise<OptionsChainSummary | null> {
  const syntheticFallback = async () => {
    const s = await getSyntheticOptionsChain(symbol, underlyingPrice, deltaTarget, dteDays, constraints);
    if (s) s.ivRank = storedIvRank;
    return s;
  };

  if (!isConnected()) return syntheticFallback();

  const contractInfo = await searchContract(symbol);
  if (!contractInfo) return syntheticFallback();

  const params = await getOptionChainParams(contractInfo.conId, symbol);
  if (!params || params.expirations.length === 0) return syntheticFallback();

  const expiry = dteDays
    ? pickBestExpiryForDte(params.expirations, dteDays, constraints?.avoidWeeks, constraints?.earningsBefore)
    : pickBestExpiry(params.expirations, constraints?.avoidWeeks, constraints?.earningsBefore);
  if (!expiry) return syntheticFallback();

  const bestPut = await findBestPutStrike(symbol, params.strikes, expiry, underlyingPrice, deltaTarget);

  if (!bestPut) return syntheticFallback();

  const bestCall = await findBestCallStrike(symbol, params.strikes, expiry, underlyingPrice);

  const currentIV = bestPut?.impliedVol ?? bestCall?.impliedVol ?? 0;

  return {
    symbol,
    underlyingPrice,
    ivRank: storedIvRank,
    currentIV,
    bestPut,
    bestCall,
    expirations: params.expirations,
  };
}

/**
 * Get only the best put opportunity for a stock — faster than full chain.
 */
export async function getBestPutOpportunity(
  symbol: string,
  underlyingPrice: number,
  storedIvRank: number | null = null,
): Promise<OptionGreeks | null> {
  const chain = await getOptionsChain(symbol, underlyingPrice, storedIvRank);
  return chain?.bestPut ?? null;
}

// ── Credit Spread Strike Finder ──────────────────────────

export interface SpreadStrikeResult {
  sellStrike: number;     // ATM — income leg (~50 delta)
  buyStrike: number;      // OTM — protection leg (~25 delta)
  expiry: string;         // YYYYMMDD
  dte: number;
  width: number;          // sellStrike - buyStrike
  sellPremium: number;    // bid of sell leg
  buyPremium: number;     // ask of buy leg
  netCredit: number;      // sellPremium - buyPremium
  creditPct: number;      // netCredit / width
  sellDelta: number;
  buyDelta: number;
  sellIV: number;
  buyIV: number;
}

/**
 * Find the best credit spread strikes for a vertical put spread.
 * Sell leg: ATM (~50 delta), Buy leg: OTM (~25 delta), same expiry.
 * Returns null if no pair meets the minimum credit % threshold.
 */
export async function findSpreadStrikes(
  symbol: string,
  underlyingPrice: number,
  right: 'P' | 'C' = 'P',
  targetDte = 45,
  minCreditPct = 0.33,
): Promise<SpreadStrikeResult | null> {
  const chain = await getOptionsChain(symbol, underlyingPrice, null, undefined, targetDte);
  if (!chain || chain.expirations.length === 0) return null;

  // Pick expiry closest to target DTE
  const expiry = chain.expirations
    .map(e => ({ e, dte: daysToExpiry(e) }))
    .filter(x => x.dte >= 14)
    .sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte))[0];
  if (!expiry) return null;

  // For synthetic chain, use Black-Scholes to evaluate multiple strike pairs
  const iv = chain.currentIV || 0.30;
  const T = expiry.dte / 365;
  const r = 0.05;
  const strikes = generateStrikesForSpread(underlyingPrice);

  if (right === 'P') {
    return findBestPutSpread(symbol, strikes, expiry.e, expiry.dte, underlyingPrice, iv, T, r, minCreditPct);
  }
  // Bear call spread
  return findBestCallSpread(symbol, strikes, expiry.e, expiry.dte, underlyingPrice, iv, T, r, minCreditPct);
}

function generateStrikesForSpread(price: number): number[] {
  const interval = price < 25 ? 1 : price < 100 ? 2.5 : price < 200 ? 5 : 10;
  const low = Math.floor(price * 0.70 / interval) * interval;
  const high = Math.ceil(price * 1.10 / interval) * interval;
  const out: number[] = [];
  for (let s = high; s >= low; s -= interval) out.push(Math.round(s * 100) / 100);
  return out;
}

async function findBestPutSpread(
  symbol: string,
  strikes: number[],
  expiry: string,
  dte: number,
  price: number,
  iv: number,
  T: number,
  r: number,
  minCreditPct: number,
): Promise<SpreadStrikeResult | null> {
  // Sell leg: ATM put (closest to stock price, delta ~0.50)
  const sellCandidates = strikes
    .filter(s => s <= price * 1.02 && s >= price * 0.95)
    .sort((a, b) => Math.abs(a - price) - Math.abs(b - price));

  // Buy leg: OTM put (~25 delta, further below price)
  let best: SpreadStrikeResult | null = null;

  for (const sellStrike of sellCandidates.slice(0, 3)) {
    // Try IB live greeks first, fall back to BS
    const sellGreeks = await getOptionGreeksForContract(symbol, sellStrike, expiry, 'P', price).catch(() => null);

    // Find the 25-delta put for the buy leg
    const buyCandidates = strikes
      .filter(s => s < sellStrike && s >= price * 0.70)
      .sort((a, b) => a - b); // ascending (furthest OTM first)

    for (const buyStrike of buyCandidates) {
      const buyGreeks = await getOptionGreeksForContract(symbol, buyStrike, expiry, 'P', price).catch(() => null);

      const width = sellStrike - buyStrike;
      if (width <= 0) continue;

      let sellBid: number, buyAsk: number, sellDelta: number, buyDelta: number, sellIV: number, buyIV: number;

      if (sellGreeks && buyGreeks) {
        sellBid = sellGreeks.bid;
        buyAsk = buyGreeks.ask;
        sellDelta = sellGreeks.delta;
        buyDelta = buyGreeks.delta;
        sellIV = sellGreeks.impliedVol;
        buyIV = buyGreeks.impliedVol;
      } else {
        // Black-Scholes fallback
        const sellBS = bsPutForSpread(price, sellStrike, T, r, iv);
        const buyBS = bsPutForSpread(price, buyStrike, T, r, iv);
        const spread = 0.05;
        sellBid = Math.max(sellBS.price - spread / 2, 0.01);
        buyAsk = buyBS.price + spread / 2;
        sellDelta = sellBS.delta;
        buyDelta = buyBS.delta;
        sellIV = iv;
        buyIV = iv;
      }

      // Buy leg delta should be in 20-30 delta range
      const absBuyDelta = Math.abs(buyDelta);
      if (absBuyDelta < 0.15 || absBuyDelta > 0.35) continue;

      const netCredit = sellBid - buyAsk;
      if (netCredit <= 0) continue;

      const creditPct = netCredit / width;
      if (creditPct < minCreditPct) continue;

      // Prefer highest credit %
      if (!best || creditPct > best.creditPct) {
        best = {
          sellStrike, buyStrike, expiry, dte,
          width, sellPremium: sellBid, buyPremium: buyAsk, netCredit, creditPct,
          sellDelta, buyDelta, sellIV, buyIV,
        };
      }

      break; // found a valid buy leg for this sell strike, move on
    }
  }

  return best;
}

async function findBestCallSpread(
  symbol: string,
  strikes: number[],
  expiry: string,
  dte: number,
  price: number,
  iv: number,
  T: number,
  r: number,
  minCreditPct: number,
): Promise<SpreadStrikeResult | null> {
  const sellCandidates = strikes
    .filter(s => s >= price * 0.98 && s <= price * 1.05)
    .sort((a, b) => Math.abs(a - price) - Math.abs(b - price));

  let best: SpreadStrikeResult | null = null;

  for (const sellStrike of sellCandidates.slice(0, 3)) {
    const sellGreeks = await getOptionGreeksForContract(symbol, sellStrike, expiry, 'C', price).catch(() => null);

    const buyCandidates = strikes
      .filter(s => s > sellStrike && s <= price * 1.30)
      .sort((a, b) => a - b);

    for (const buyStrike of buyCandidates) {
      const buyGreeks = await getOptionGreeksForContract(symbol, buyStrike, expiry, 'C', price).catch(() => null);

      const width = buyStrike - sellStrike;
      if (width <= 0) continue;

      let sellBid: number, buyAsk: number, sellDelta: number, buyDelta: number, sellIV: number, buyIV: number;

      if (sellGreeks && buyGreeks) {
        sellBid = sellGreeks.bid;
        buyAsk = buyGreeks.ask;
        sellDelta = sellGreeks.delta;
        buyDelta = buyGreeks.delta;
        sellIV = sellGreeks.impliedVol;
        buyIV = buyGreeks.impliedVol;
      } else {
        const sellBS = bsCallForSpread(price, sellStrike, T, r, iv);
        const buyBS = bsCallForSpread(price, buyStrike, T, r, iv);
        const spread = 0.05;
        sellBid = Math.max(sellBS.price - spread / 2, 0.01);
        buyAsk = buyBS.price + spread / 2;
        sellDelta = sellBS.delta;
        buyDelta = buyBS.delta;
        sellIV = iv;
        buyIV = iv;
      }

      const absBuyDelta = Math.abs(buyDelta);
      if (absBuyDelta < 0.15 || absBuyDelta > 0.35) continue;

      const netCredit = sellBid - buyAsk;
      if (netCredit <= 0) continue;

      const creditPct = netCredit / width;
      if (creditPct < minCreditPct) continue;

      if (!best || creditPct > best.creditPct) {
        best = {
          sellStrike, buyStrike, expiry, dte,
          width, sellPremium: sellBid, buyPremium: buyAsk, netCredit, creditPct,
          sellDelta, buyDelta, sellIV, buyIV,
        };
      }
      break;
    }
  }

  return best;
}

/** Simplified BS put for spread evaluation */
function bsPutForSpread(S: number, K: number, T: number, r: number, v: number) {
  if (T <= 0) return { price: Math.max(K - S, 0), delta: -1 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const price = K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  const delta = normCdf(d1) - 1;
  return { price, delta };
}

/** Simplified BS call for spread evaluation */
function bsCallForSpread(S: number, K: number, T: number, r: number, v: number) {
  if (T <= 0) return { price: Math.max(S - K, 0), delta: 1 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const price = S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  const delta = normCdf(d1);
  return { price, delta };
}

// ── Strike Sniper ─────────────────────────────────────────

export interface StrikeSniperResult {
  expiry: string;
  strike: number;
  premium: number;
  delta: number;
  annualizedROI: number;
  dte: number;
  collateral: number;
}

/**
 * Given a user-specified target strike price, find the best put contract
 * across multiple expirations, ranked by annualized ROI.
 */
export async function findBestContractForStrike(
  symbol: string,
  targetStrike: number,
  minAnnualizedReturn = 8,
  underlyingPrice?: number,
): Promise<StrikeSniperResult[]> {
  const results: StrikeSniperResult[] = [];

  const contractInfo = await searchContract(symbol);
  if (!contractInfo) return results;

  const spotPrice = underlyingPrice ?? targetStrike;

  const params = await getOptionChainParams(contractInfo.conId, symbol);
  if (!params || params.expirations.length === 0) return results;

  // Find the strike closest to the user's target
  const closestStrike = params.strikes.reduce((best, s) =>
    Math.abs(s - targetStrike) < Math.abs(best - targetStrike) ? s : best,
    params.strikes[0],
  );

  // Try each expiration in the 14–90 DTE window
  const eligibleExpiries = params.expirations
    .map(e => ({ e, dte: daysToExpiry(e) }))
    .filter(x => x.dte >= 14 && x.dte <= 90)
    .sort((a, b) => a.dte - b.dte);

  for (const { e: expiry, dte } of eligibleExpiries) {
    const greeks = await getOptionGreeksForContract(symbol, closestStrike, expiry, 'P', spotPrice);
    if (!greeks || greeks.mid <= 0) continue;

    const premium = greeks.mid;
    const collateral = closestStrike * 100;
    const annualizedROI = (premium / closestStrike) * (365 / dte) * 100;

    if (annualizedROI < minAnnualizedReturn) continue;

    results.push({
      expiry,
      strike: closestStrike,
      premium,
      delta: greeks.delta,
      annualizedROI: Math.round(annualizedROI * 100) / 100,
      dte,
      collateral,
    });
  }

  return results.sort((a, b) => b.annualizedROI - a.annualizedROI);
}
