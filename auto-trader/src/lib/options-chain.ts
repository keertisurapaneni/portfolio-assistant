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
import { getIBApi, getNextOrderId, isConnected, searchContract } from '../ib-connection.js';

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
 * Estimate annualized IV from 30-day realized volatility via Finnhub candles.
 * Applies a 1.2× vol-risk-premium scalar and clamps to [15%, 150%].
 */
async function estimateIV(symbol: string): Promise<number> {
  const key = process.env.FINNHUB_API_KEY ?? '';
  try {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - 86_400 * 60;
    const res  = await fetch(
      `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${to}&token=${key}`
    );
    if (!res.ok) return 0.30;
    const data = await res.json() as { c?: number[] };
    const closes = data.c ?? [];
    if (closes.length < 20) return 0.30;
    const sample = closes.slice(-31);
    const returns = sample.slice(1).map((c, i) => Math.log(c / sample[i]));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const hv = Math.sqrt(variance * 252);
    return Math.min(Math.max(hv * 1.2, 0.15), 1.50); // IV premium over HV
  } catch {
    return 0.30;
  }
}

/**
 * Build a synthetic options chain using Black-Scholes when IB is unavailable.
 * IV is estimated from 30-day realized volatility via Finnhub.
 */
async function getSyntheticOptionsChain(
  symbol: string,
  underlyingPrice: number,
  deltaTarget = 0.22,
  dteDays?: number,
): Promise<OptionsChainSummary | null> {
  const iv       = await estimateIV(symbol);
  const expiries = getMonthlyExpiries(4);
  const expiry   = dteDays ? pickBestExpiryForDte(expiries, dteDays) : pickBestExpiry(expiries);
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

function pickBestExpiry(expirations: string[]): string | null {
  // Target 30–45 DTE for optimal theta decay
  const candidates = expirations
    .map(e => ({ e, dte: daysToExpiry(e) }))
    .filter(x => x.dte >= 25 && x.dte <= 50)
    .sort((a, b) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38));
  return candidates[0]?.e ?? null;
}

/** Pick expiry closest to a specific DTE target (e.g. 21 for bear mode). */
function pickBestExpiryForDte(expirations: string[], targetDte: number): string | null {
  const minDte = Math.max(7, targetDte - 10);
  const maxDte = targetDte + 14;
  const candidates = expirations
    .map(e => ({ e, dte: daysToExpiry(e) }))
    .filter(x => x.dte >= minDte && x.dte <= maxDte)
    .sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  return candidates[0]?.e ?? null;
}

// ── Get Option Chain Parameters ───────────────────────────

interface OptionParams {
  expirations: string[];
  strikes: number[];
  multiplier: string;
  tradingClass: string;
}

function getOptionChainParams(conId: number, symbol: string): Promise<OptionParams | null> {
  return new Promise((resolve) => {
    const ib = getIBApi();
    if (!ib || !isConnected()) return resolve(null);

    const reqId = getNextOrderId();
    const emitter = ib as unknown as NodeJS.EventEmitter;
    let resolved = false;
    const allParams: OptionParams[] = [];

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; emitter.off(EventName.securityDefinitionOptionParameter, paramHandler); emitter.off(EventName.securityDefinitionOptionParameterEnd, endHandler); resolve(allParams[0] ?? null); }
    }, 15_000);

    const paramHandler = (rId: number, exchange: string, _conId: number, tradingClass: string, multiplier: string, expirations: string[], strikes: number[]) => {
      if (rId !== reqId) return;
      // Prefer SMART exchange data
      if (exchange === 'SMART' || allParams.length === 0) {
        allParams.unshift({ expirations: Array.from(expirations).sort(), strikes: Array.from(strikes).sort((a, b) => a - b), multiplier, tradingClass });
      } else {
        allParams.push({ expirations: Array.from(expirations).sort(), strikes: Array.from(strikes).sort((a, b) => a - b), multiplier, tradingClass });
      }
    };

    const endHandler = (rId: number) => {
      if (rId !== reqId || resolved) return;
      resolved = true;
      clearTimeout(timeout);
      emitter.off(EventName.securityDefinitionOptionParameter, paramHandler);
      emitter.off(EventName.securityDefinitionOptionParameterEnd, endHandler);
      resolve(allParams[0] ?? null);
    };

    emitter.on(EventName.securityDefinitionOptionParameter, paramHandler);
    emitter.on(EventName.securityDefinitionOptionParameterEnd, endHandler);

    (ib as unknown as { reqSecDefOptParams: (reqId: number, symbol: string, exchange: string, secType: string, conId: number) => void })
      .reqSecDefOptParams(reqId, symbol.toUpperCase(), '', 'STK', conId);
  });
}

// ── Get Greeks for a Specific Option Contract ─────────────

function getOptionGreeksForContract(
  symbol: string,
  strike: number,
  expiry: string,
  optionType: 'P' | 'C',
  underlyingPrice: number,
): Promise<OptionGreeks | null> {
  return new Promise((resolve) => {
    const ib = getIBApi();
    if (!ib || !isConnected()) return resolve(null);

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
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        if (impliedVol > 0 && delta !== 0) {
          resolve(buildResult());
        } else {
          resolve(null);
        }
      }
    }, 12_000);

    function cleanup() {
      emitter.off(EventName.tickOptionComputation, greeksHandler);
      emitter.off(EventName.tickPrice, priceHandler);
      emitter.off(EventName.error, errorHandler);
      try { (ib as unknown as { cancelMktData: (id: number) => void }).cancelMktData(reqId); } catch { /* ignore */ }
    }

    function buildResult(): OptionGreeks {
      const mid = bidPrice >= 0 && askPrice >= 0 ? (bidPrice + askPrice) / 2 : Math.max(bidPrice, askPrice, 0);
      // Simulate realistic fill at mid - $0.05
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const greeksHandler = (tickerId: number, _tickType: number, _tickAttrib: number, iv: number, d: number, _optPrice: number, _pvDiv: number, g: number, v: number, t: number, _undPrice: number) => {
      if (tickerId !== reqId) return;
      if (iv && iv > 0 && iv < 5) impliedVol = iv;  // sanity check: IV as decimal
      if (d && d !== 0 && Math.abs(d) <= 1) delta = d;
      if (t && t !== 0) theta = t;
      if (g && g !== 0) gamma = g;
      if (v && v !== 0) vega = v;

      // Resolve once we have IV + delta + both prices
      if (!resolved && impliedVol > 0 && delta !== 0 && bidPrice >= 0 && askPrice >= 0) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        resolve(buildResult());
      }
    };

    const priceHandler = (tickerId: number, tickType: number, price: number) => {
      if (tickerId !== reqId) return;
      if (tickType === 1) bidPrice = price;  // BID
      if (tickType === 2) askPrice = price;  // ASK
    };

    // Immediately bail on "not subscribed" errors — no point waiting 12 s per strike.
    // IB error event signature: (err: Error, code: number, reqId: number)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorHandler = (_err: any, code: number, id: number) => {
      if (id !== reqId) return;
      // 354 = not subscribed, 10091 = needs additional subscription
      if ((code === 354 || code === 10091) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        resolve(null);
      }
    };

    emitter.on(EventName.tickOptionComputation, greeksHandler);
    emitter.on(EventName.tickPrice, priceHandler);
    emitter.on(EventName.error, errorHandler);

    // Request market data — for OPT contracts tickOptionComputation fires automatically;
    // generic tick 13 is invalid for options, so use empty string to avoid IB error 321.
    (ib as unknown as { reqMktData: (id: number, c: Contract, genericTicks: string, snapshot: boolean, regulatory: boolean, options: unknown[]) => void })
      .reqMktData(reqId, contract, '', false, false, []);
  });
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

// ── Main Export ──────────────────────────────────────────

/**
 * Get the full options chain summary for a stock.
 * Uses live IB data when connected; falls back to a Black-Scholes synthetic
 * chain (Finnhub HV-derived IV) so the scanner can run without IB Gateway.
 */
export async function getOptionsChain(
  symbol: string,
  underlyingPrice: number,
  storedIvRank: number | null = null,
  deltaTarget?: number,   // override delta target (bear mode uses 0.15)
  dteDays?: number,       // override DTE window center (bear mode uses 21)
): Promise<OptionsChainSummary | null> {
  const syntheticFallback = async () => {
    const s = await getSyntheticOptionsChain(symbol, underlyingPrice, deltaTarget, dteDays);
    if (s) s.ivRank = storedIvRank;
    return s;
  };

  if (!isConnected()) return syntheticFallback();

  // Step 1–4: Try live IB data. Fall back to synthetic at any failure point so the
  // scanner keeps running even when market data subscriptions are missing.
  const contractInfo = await searchContract(symbol);
  if (!contractInfo) return syntheticFallback();

  const params = await getOptionChainParams(contractInfo.conId, symbol);
  if (!params || params.expirations.length === 0) return syntheticFallback();

  // Step 3: Pick the best expiry — bear mode targets 21 DTE, normal 30-45 DTE
  const expiry = dteDays
    ? pickBestExpiryForDte(params.expirations, dteDays)
    : pickBestExpiry(params.expirations);
  if (!expiry) return syntheticFallback();

  // Step 4: Find best put strike — use caller-specified delta target if provided
  const bestPut = await findBestPutStrike(symbol, params.strikes, expiry, underlyingPrice, deltaTarget);

  // If Greeks failed (e.g. market data not subscribed), fall back to synthetic.
  if (!bestPut) return syntheticFallback();

  // Step 5: Optionally find best covered call (just above current price)
  const callStrike = params.strikes.find(s => s > underlyingPrice * 1.05) ?? null;
  let bestCall: OptionGreeks | null = null;
  if (callStrike) {
    bestCall = await getOptionGreeksForContract(symbol, callStrike, expiry, 'C', underlyingPrice);
  }

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
