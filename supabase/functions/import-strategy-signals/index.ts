/**
 * Import extracted signals from a daily_signal strategy_video into external_strategy_signals.
 * Called automatically after extraction completes. No manual approval needed — paper trading only.
 *
 * POST body: { video_id: string; platform?: string }
 *
 * Flow:
 * 1. Load strategy_video (must be daily_signal, ingest_status=done, extracted_signals populated)
 * 2. For each extracted signal: create PENDING external_strategy_signals rows
 *    - longTriggerAbove  → BUY signal
 *    - shortTriggerBelow → SELL signal
 *    - entry_context (above_todays_high / below_todays_low) → resolves via Finnhub → BUY/SELL signal
 * 3. If execution_window_et present: set execute_at / expires_at (ET timezone)
 * 4. Skip if signal already exists for same video_id + ticker + signal direction (idempotent)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface ExtractedSignal {
  ticker?: string;
  longTriggerAbove?: number | null;
  longTargets?: number[];
  shortTriggerBelow?: number | null;
  shortTargets?: number[];
  stopLoss?: number | null;
  notes?: string | null;
  // Options signal fields (from options_signal strategy_type)
  signal?: 'BUY_CALL' | 'BUY_PUT';
  entry_context?: 'above_todays_high' | 'above_level' | 'below_todays_low' | 'below_level';
  trigger_price?: number | null;
  targets?: number[];
  setup_type?: string | null;
}

interface ExecutionWindow {
  start?: string; // "HH:MM" ET
  end?: string;
}

/** Convert "HH:MM" ET string on a given YYYY-MM-DD into a UTC ISO timestamp */
function toUtcTimestamp(date: string, timeEt: string): string {
  // Use Intl to correctly determine the UTC offset for America/New_York on the given date.
  // This handles DST transitions precisely (e.g. DST starts second Sunday of March).
  const [hh, mm] = timeEt.split(':').map(Number);
  const localIso = `${date}T${String(hh ?? 0).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')}:00`;
  // Get the UTC offset for America/New_York on this date by parsing a formatted string
  const probe = new Date(`${date}T12:00:00`);
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const utcFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const etH = parseInt(etFormatter.formatToParts(probe).find(p => p.type === 'hour')?.value ?? '12');
  const utcH = parseInt(utcFormatter.formatToParts(probe).find(p => p.type === 'hour')?.value ?? '12');
  const offsetHours = utcH - etH; // e.g. 5 (EST) or 4 (EDT)
  // Apply offset to the requested time
  const resultDate = new Date(`${localIso}Z`);
  resultDate.setUTCHours(resultDate.getUTCHours() + offsetHours);
  return resultDate.toISOString().replace('.000Z', 'Z');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { video_id?: string; platform?: string };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const videoId = (body.video_id ?? '').trim();
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'video_id required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Load the strategy_video
  const { data: video, error: fetchErr } = await supabase
    .from('strategy_videos')
    .select('video_id, platform, source_name, source_handle, canonical_url, reel_url, video_heading, strategy_type, trade_date, timeframe, applicable_timeframes, execution_window_et, extracted_signals, setup_type')
    .eq('video_id', videoId)
    .eq('status', 'tracked')
    .maybeSingle();

  if (fetchErr || !video) {
    return new Response(JSON.stringify({ error: fetchErr?.message ?? 'Video not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (video.strategy_type !== 'daily_signal' && video.strategy_type !== 'daily_penny' && video.strategy_type !== 'options_signal') {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'Not a daily_signal, daily_penny, or options_signal — no signals to import' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const isPenny = video.strategy_type === 'daily_penny';
  const isOptionsSignal = video.strategy_type === 'options_signal';

  const signals = (Array.isArray(video.extracted_signals) ? video.extracted_signals : []) as ExtractedSignal[];
  if (signals.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'No extracted_signals in video' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!video.trade_date) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'No trade_date on video — cannot schedule signals' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Don't create signals for weekends — market is closed
  const tradeDay = new Date(`${video.trade_date}T12:00:00Z`).getDay(); // 0=Sun, 6=Sat
  if (tradeDay === 0 || tradeDay === 6) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: `trade_date ${video.trade_date} falls on a weekend — market closed` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const tradeDate = video.trade_date as string;
  const executionWindow = video.execution_window_et as ExecutionWindow | null;
  const setupType = (video.setup_type as string | null) ?? null;
  const sourceHandle = (video.source_handle ?? '').trim().toLowerCase();
  const sourceUrl = sourceHandle
    ? `https://www.instagram.com/${sourceHandle}/`
    : ((video.canonical_url ?? video.reel_url ?? null) as string | null);

  // Determine mode from timeframe / applicable_timeframes
  const applicableTimeframes = Array.isArray(video.applicable_timeframes) ? video.applicable_timeframes : [];
  const timeframe = (video.timeframe as string | null) ?? null;
  const primaryMode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM' | 'DAY_PENNY' =
    isPenny
      ? 'DAY_PENNY'
      : applicableTimeframes.includes('DAY_TRADE') || timeframe === 'DAY_TRADE'
      ? 'DAY_TRADE'
      : applicableTimeframes.includes('SWING_TRADE') || timeframe === 'SWING_TRADE'
      ? 'SWING_TRADE'
      : 'DAY_TRADE';

  // Build execute_at / expires_at from execution_window_et.
  // Influencer pre-market setups have different timing needs per setup type.
  // Expiry windows are generous to absorb ingestion delays (transcript download,
  // LLM extraction, edge function processing) while still preventing stale
  // afternoon execution.
  //
  //   breakout      — 9:35 AM start, 11:00 AM expiry
  //   momentum      — 9:35 AM start, 12:00 PM expiry
  //   pullback_vwap — 9:35 AM start, 13:00 PM expiry
  //   range         — 9:35 AM start, 14:30 PM expiry
  //   default/null  — 9:35 AM start, 12:00 PM expiry
  let executeAt: string | null = null;
  let expiresAt: string | null = null;
  if (executionWindow?.start) {
    executeAt = toUtcTimestamp(tradeDate, executionWindow.start);
  }
  if (executionWindow?.end) {
    expiresAt = toUtcTimestamp(tradeDate, executionWindow.end);
  }

  if (primaryMode === 'DAY_PENNY') {
    // Penny momentum window: 7:00 AM pre-market scan through 10:00 AM ET
    if (!executeAt) {
      executeAt = toUtcTimestamp(tradeDate, '09:35');
    }
    if (!expiresAt) {
      expiresAt = toUtcTimestamp(tradeDate, '10:00');
    }
  } else if (primaryMode === 'DAY_TRADE') {
    if (!executeAt) {
      executeAt = toUtcTimestamp(tradeDate, '09:35');
    }
    if (!expiresAt) {
      const expiryBySetup: Record<string, string> = {
        breakout:      '11:00',
        momentum:      '12:00',
        pullback_vwap: '13:00',
        range:         '14:30',
      };
      const defaultExpiry = '12:00';
      expiresAt = toUtcTimestamp(tradeDate, expiryBySetup[setupType ?? ''] ?? defaultExpiry);
    }
  } else {
    // Swing/long-term: default expiry is end of trading day
    if (!expiresAt) {
      const month = parseInt(tradeDate.split('-')[1], 10);
      const etOffset = month >= 3 && month <= 11 ? 4 : 5;
      expiresAt = `${tradeDate}T${16 + etOffset}:00:00Z`;
    }
  }

  const finnhubApiKey = Deno.env.get('FINNHUB_API_KEY');

  // Well-known ETFs that Finnhub stock/profile2 returns empty for — always valid
  const KNOWN_ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VXX', 'TQQQ', 'SQQQ', 'SPXU', 'SPXL', 'UVXY', 'GLD', 'SLV', 'TLT', 'HYG', 'XLF', 'XLE', 'XLK', 'XLV', 'ARKK']);

  /**
   * Returns true if the ticker exists on Finnhub AND is listed on a named exchange.
   * Tickers with an empty exchange field are OTC/Pink Sheet stocks — IB rejects
   * orders for them with code=200 "No security definition found". Filter them out
   * at import time so they never reach the IB order pipeline.
   */
  async function isValidTicker(ticker: string): Promise<boolean> {
    if (KNOWN_ETFS.has(ticker)) return true; // ETFs don't have a profile2 — skip Finnhub check
    if (!finnhubApiKey) return true; // can't validate without key — let it through
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${finnhubApiKey}`,
        { signal: AbortSignal.timeout(5_000) }
      );
      if (!res.ok) return true; // don't block on Finnhub errors
      const data = await res.json() as Record<string, unknown>;
      if (!data?.name) return false; // empty object = ticker not found
      // OTC/Pink Sheet stocks have an empty exchange field — IB cannot trade them.
      if (typeof data.exchange === 'string' && data.exchange.trim() === '') {
        console.warn(`[import-strategy-signals] Skipping ${ticker} — OTC/Pink Sheet stock (exchange="") not supported by IB`);
        return false;
      }
      return true;
    } catch {
      return true; // don't block on network errors
    }
  }

  /** Fetch Finnhub quote for a ticker — returns { c: current, h: high, l: low, pc: prevClose } or null */
  async function getFinnhubQuote(ticker: string): Promise<{ c: number; h: number; l: number; pc: number } | null> {
    if (!finnhubApiKey) return null;
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${finnhubApiKey}`,
        { signal: AbortSignal.timeout(5_000) }
      );
      if (!res.ok) return null;
      const data = await res.json() as Record<string, unknown>;
      if (!data?.c || data.c === 0) return null;
      return data as unknown as { c: number; h: number; l: number; pc: number };
    } catch {
      return null;
    }
  }

  /** Compute next trading day after tradeDate (skips weekends) */
  function nextTradingDay(dateStr: string): string {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  const toInsert: Record<string, unknown>[] = [];

  for (const sig of signals) {
    const ticker = (sig.ticker ?? '').trim().toUpperCase();
    if (!ticker) continue;

    const valid = await isValidTicker(ticker);
    if (!valid) {
      console.warn(`[import-strategy-signals] Skipping invalid ticker "${ticker}" — not found in Finnhub`);
      continue;
    }

    // Sanity-check price levels against known approximate ranges for well-known tickers.
    // Catches LLM errors like extracting "6.10" instead of "610" for META.
    const PRICE_FLOOR: Record<string, number> = {
      META: 200, AAPL: 100, MSFT: 200, NVDA: 50, GOOGL: 100, GOOG: 100,
      AMZN: 100, TSLA: 100, PLTR: 20, NFLX: 200, AMD: 50, CRM: 100,
      SPY: 300, QQQ: 200, IWM: 100, DIA: 200,
    };
    const priceFloor = PRICE_FLOOR[ticker];
    const allPriceLevels = [
      sig.longTriggerAbove, sig.shortTriggerBelow,
      ...(sig.longTargets ?? []), ...(sig.shortTargets ?? []),
      sig.trigger_price, ...(sig.targets ?? []),
    ].filter((p): p is number => p != null);
    if (priceFloor && allPriceLevels.some(p => p < priceFloor)) {
      console.warn(`[import-strategy-signals] Skipping ${ticker} — price levels ${JSON.stringify(allPriceLevels)} below minimum $${priceFloor} (likely extraction error)`);
      continue;
    }

    const stopLoss = sig.stopLoss ?? null;
    const noteText = sig.notes ?? null;

    // Options signal path (BUY_CALL / BUY_PUT from pocket/breakout setups)
    // Fallback: when strategy_type is options_signal but the LLM returned the
    // longTriggerAbove/shortTriggerBelow format instead of BUY_CALL/BUY_PUT,
    // convert automatically so these don't get misrouted as DAY_TRADE.
    let effectiveSignal = sig.signal;
    if (isOptionsSignal && !effectiveSignal) {
      if (sig.longTriggerAbove != null) effectiveSignal = 'BUY_CALL';
      else if (sig.shortTriggerBelow != null) effectiveSignal = 'BUY_PUT';
    }

    if (isOptionsSignal && (effectiveSignal === 'BUY_CALL' || effectiveSignal === 'BUY_PUT')) {
      const isCall = effectiveSignal === 'BUY_CALL';
      const mode = isCall ? 'OPTIONS_CALL' : 'OPTIONS_PUT';
      const targets = sig.targets ?? (isCall ? sig.longTargets : sig.shortTargets) ?? [];
      const primaryTarget = targets[0] ?? null;
      const targetSummary = targets.length > 0
        ? targets.map((t, i) => `T${i + 1}: ${t}`).join(', ')
        : null;

      let entryPrice = sig.trigger_price ?? (isCall ? sig.longTriggerAbove : sig.shortTriggerBelow) ?? null;
      const entryCtx = sig.entry_context ?? (entryPrice != null ? 'above_level' : 'above_todays_high');

      // Resolve "above_todays_high" / "below_todays_low" using Finnhub quote
      if (entryPrice == null && (entryCtx === 'above_todays_high' || entryCtx === 'below_todays_low')) {
        const quote = await getFinnhubQuote(ticker);
        if (quote) {
          // Pre-market: use previous close as proxy; during market hours: use day high/low
          const nowHourET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
          const hourET = parseInt(nowHourET);
          if (entryCtx === 'above_todays_high') {
            const raw = (hourET >= 10 && hourET < 16 && quote.h > 0) ? quote.h : quote.pc;
            entryPrice = Math.round(raw * 1.002 * 100) / 100; // +0.2% buffer
          } else {
            const raw = (hourET >= 10 && hourET < 16 && quote.l > 0) ? quote.l : quote.pc;
            entryPrice = Math.round(raw * 0.998 * 100) / 100; // -0.2% buffer
          }
          console.log(`[import-strategy-signals] ${ticker}: resolved ${entryCtx} → $${entryPrice} (from Finnhub ${hourET >= 10 ? 'intraday' : 'prevClose'})`);
        } else {
          console.warn(`[import-strategy-signals] ${ticker}: could not resolve ${entryCtx} — no Finnhub quote, skipping`);
          continue;
        }
      }

      // Options signals expire at end of next trading day (generous window for breakout triggers)
      const optionsExpiresAt = toUtcTimestamp(nextTradingDay(tradeDate), '16:00');
      const optionsExecuteAt = toUtcTimestamp(tradeDate, '09:35');

      const setupLabel = sig.setup_type ?? setupType ?? 'breakout';
      const notesParts = [
        `${isCall ? 'Call' : 'Put'} — ${setupLabel}`,
        entryCtx === 'above_todays_high' ? 'above today\'s high' :
          entryCtx === 'below_todays_low' ? 'below today\'s low' :
          entryPrice != null ? `${isCall ? 'above' : 'below'} $${entryPrice}` : null,
        targetSummary ? `targets: ${targetSummary}` : null,
      ].filter(Boolean).join(' | ');

      toInsert.push({
        source_name: video.source_name,
        source_url: sourceUrl,
        ticker,
        signal: 'BUY',
        mode,
        confidence: 7,
        entry_price: entryPrice,
        stop_loss: null,
        target_price: primaryTarget,
        execute_on_date: tradeDate,
        execute_at: optionsExecuteAt,
        expires_at: optionsExpiresAt,
        notes: notesParts,
        status: 'PENDING',
        strategy_video_id: videoId,
        strategy_video_heading: video.video_heading ?? null,
      });
      continue;
    }

    // Resolve entry_context for stock signals when the LLM did not give an explicit price.
    // e.g. "above today's high" / "below today's low" — fetch Finnhub to get a concrete level.
    let resolvedLongTrigger = sig.longTriggerAbove ?? null;
    let resolvedShortTrigger = sig.shortTriggerBelow ?? null;
    const stockEntryCtx = sig.entry_context ?? null;

    if (stockEntryCtx && (resolvedLongTrigger == null || resolvedShortTrigger == null)) {
      const quote = await getFinnhubQuote(ticker);
      if (quote) {
        const nowHourET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
        const hourET = parseInt(nowHourET);
        const intraday = hourET >= 10 && hourET < 16;

        if (resolvedLongTrigger == null && (stockEntryCtx === 'above_todays_high' || stockEntryCtx === 'above_level')) {
          const raw = (intraday && quote.h > 0) ? quote.h : quote.pc;
          resolvedLongTrigger = Math.round(raw * 1.002 * 100) / 100; // +0.2% buffer above high
          console.log(`[import-strategy-signals] ${ticker}: resolved ${stockEntryCtx} → long trigger $${resolvedLongTrigger} (Finnhub ${intraday ? 'intraday high' : 'prevClose'})`);
        }
        if (resolvedShortTrigger == null && (stockEntryCtx === 'below_todays_low' || stockEntryCtx === 'below_level')) {
          const raw = (intraday && quote.l > 0) ? quote.l : quote.pc;
          resolvedShortTrigger = Math.round(raw * 0.998 * 100) / 100; // -0.2% buffer below low
          console.log(`[import-strategy-signals] ${ticker}: resolved ${stockEntryCtx} → short trigger $${resolvedShortTrigger} (Finnhub ${intraday ? 'intraday low' : 'prevClose'})`);
        }
      } else {
        console.warn(`[import-strategy-signals] ${ticker}: entry_context="${stockEntryCtx}" but no Finnhub quote — skipping`);
        continue;
      }
    }

    // Long (BUY) signal — one row per entry level (unique constraint is on ticker+signal+entry_price+date).
    // Use the first target as primary; additional targets go into notes for human reference.
    if (resolvedLongTrigger != null) {
      const entryPrice = resolvedLongTrigger;
      const longTargets = sig.longTargets ?? [];
      const primaryTarget = longTargets[0] ?? null;
      const targetSummary = longTargets.length > 0
        ? longTargets.map((t, i) => `T${i + 1}: ${t}`).join(', ')
        : null;
      const entryDesc = stockEntryCtx === 'above_todays_high'
        ? `Long above today's high (~${entryPrice})`
        : `Long above ${entryPrice}`;
      // Sub-$5 entry price = penny stock (SEC threshold) → DAY_PENNY regardless of channel.
      const signalMode = primaryMode === 'DAY_TRADE' && entryPrice < 5 ? 'DAY_PENNY' : primaryMode;
      toInsert.push({
        source_name: video.source_name,
        source_url: sourceUrl,
        ticker,
        signal: 'BUY',
        mode: signalMode,
        confidence: 7,
        entry_price: entryPrice,
        stop_loss: stopLoss ?? (resolvedShortTrigger ?? null),
        target_price: primaryTarget,
        execute_on_date: tradeDate,
        execute_at: executeAt,
        expires_at: expiresAt,
        notes: noteText ?? `${entryDesc}${targetSummary ? ` — targets: ${targetSummary}` : ''}`,
        status: 'PENDING',
        strategy_video_id: videoId,
        strategy_video_heading: video.video_heading ?? null,
      });
    }

    // Short (SELL) signal — one row per entry level.
    if (resolvedShortTrigger != null) {
      const entryPrice = resolvedShortTrigger;
      const shortTargets = sig.shortTargets ?? [];
      const primaryTarget = shortTargets[0] ?? null;
      const targetSummary = shortTargets.length > 0
        ? shortTargets.map((t, i) => `T${i + 1}: ${t}`).join(', ')
        : null;
      const entryDesc = stockEntryCtx === 'below_todays_low'
        ? `Short below today's low (~${entryPrice})`
        : `Short below ${entryPrice}`;
      // Sub-$5 entry price = penny stock (SEC threshold) → DAY_PENNY regardless of channel.
      const signalMode = primaryMode === 'DAY_TRADE' && entryPrice < 5 ? 'DAY_PENNY' : primaryMode;
      toInsert.push({
        source_name: video.source_name,
        source_url: sourceUrl,
        ticker,
        signal: 'SELL',
        mode: signalMode,
        confidence: 7,
        entry_price: entryPrice,
        stop_loss: stopLoss ?? (resolvedLongTrigger ?? null),
        target_price: primaryTarget,
        execute_on_date: tradeDate,
        execute_at: executeAt,
        expires_at: expiresAt,
        notes: noteText ?? `${entryDesc}${targetSummary ? ` — targets: ${targetSummary}` : ''}`,
        status: 'PENDING',
        strategy_video_id: videoId,
        strategy_video_heading: video.video_heading ?? null,
      });
    }
  }

  if (toInsert.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, imported: 0, reason: 'No long/short triggers found in extracted_signals' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Delete all existing PENDING signals for this video before re-importing.
  // This ensures a clean replacement when trade_date changes or signals are corrected —
  // avoids duplicates across different execute_on_date values.
  await supabase
    .from('external_strategy_signals')
    .delete()
    .eq('strategy_video_id', videoId)
    .eq('status', 'PENDING');

  const { error: insertErr } = await supabase
    .from('external_strategy_signals')
    .insert(toInsert);

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: insertErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      imported: toInsert.length,
      tickers: toInsert.map(s => `${s.ticker} ${s.signal}`),
      execute_on_date: tradeDate,
      execute_at: executeAt,
      expires_at: expiresAt,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
