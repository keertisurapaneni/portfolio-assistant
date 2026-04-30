import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { cn } from '../lib/utils';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? '',
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
);

interface SchedulerStatus {
  running: boolean;       // cron job is active
  executing: boolean;     // currently mid-cycle
  lastRun: string | null; // ISO timestamp
  lastResult: string;     // 'ok (12.3s)' | 'error: ...' | 'never' | 'skipped: ...'
  runCount: number;
  ibConnected: boolean;
}

type HealthLevel = 'healthy' | 'warning' | 'error' | 'idle';

const AUTO_TRADER_URL = import.meta.env.VITE_AUTO_TRADER_URL ?? 'http://localhost:3001';

function isMarketHours(): boolean {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hour = et.getHours();
  const min = et.getMinutes();
  // 9:30 AM – 4:30 PM ET
  if (hour < 9 || hour > 16) return false;
  if (hour === 9 && min < 30) return false;
  if (hour === 16 && min > 30) return false;
  return true;
}

function getHealthLevel(
  status: SchedulerStatus | null,
  reachable: boolean,
  heartbeat: HeartbeatRow | null,
): HealthLevel {
  // If live endpoint is reachable, use it as source of truth
  if (reachable && status) {
    if (!isMarketHours()) return 'idle';
    if (status.lastResult.startsWith('error')) return 'error';
    if (status.lastResult === 'never') return 'warning';
    if (status.lastRun) {
      const minutesAgo = (Date.now() - new Date(status.lastRun).getTime()) / 60000;
      if (minutesAgo > 120) return 'error';
      if (minutesAgo > 30) return 'warning';
    }
    if (status.lastResult.startsWith('ok') || status.lastResult.startsWith('skipped')) return 'healthy';
    return 'warning';
  }

  // Service unreachable — fall back to Supabase heartbeat
  if (heartbeat) {
    const minsAgo = (Date.now() - new Date(heartbeat.last_seen_at).getTime()) / 60000;
    if (isMarketHours()) {
      if (minsAgo > 30) return 'error';   // stale during market hours = problem
      if (minsAgo > 10) return 'warning';
      return heartbeat.status === 'error' ? 'error'
           : heartbeat.status === 'degraded' ? 'warning' : 'healthy';
    }
    // Outside market hours: show degraded if stale > 4h (service may have crashed overnight)
    if (minsAgo > 240) return 'warning';
    return 'idle';
  }

  return 'idle';
}

function timeAgo(isoStr: string | null): string {
  if (!isoStr) return 'never';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface HeartbeatRow {
  last_seen_at: string;
  status: 'ok' | 'degraded' | 'error';
  ib_connected: boolean;
  active_trades: number;
  last_cycle_result: string | null;
  run_count: number;
}

export function EngineHealthIndicator() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatRow | null>(null);
  const [reachable, setReachable] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const popoverRef = useRef<HTMLDivElement>(null);

  async function fetchStatus() {
    // Try the live HTTP endpoint first
    try {
      const res = await fetch(`${AUTO_TRADER_URL}/api/scheduler/status`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error('not ok');
      const data = await res.json() as SchedulerStatus;
      setStatus(data);
      setReachable(true);
    } catch {
      setReachable(false);
      setStatus(null);
    }

    // Always fetch Supabase heartbeat as fallback / corroboration
    try {
      const { data } = await supabase
        .from('system_heartbeats')
        .select('last_seen_at, status, ib_connected, active_trades, last_cycle_result, run_count')
        .eq('id', 'auto-trader')
        .single();
      setHeartbeat(data as HeartbeatRow | null);
    } catch {
      // Non-blocking
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60 * 1000); // refresh every minute
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const health = getHealthLevel(status, reachable, heartbeat);

  const dotColor: Record<HealthLevel, string> = {
    healthy: 'bg-emerald-500',
    warning: 'bg-amber-400',
    error: 'bg-red-500',
    idle: 'bg-slate-300',
  };

  const pulseColor: Record<HealthLevel, string> = {
    healthy: 'bg-emerald-400',
    warning: 'bg-amber-300',
    error: 'bg-red-400',
    idle: '',
  };

  const label: Record<HealthLevel, string> = {
    healthy: reachable ? 'Engine running' : 'Engine running (heartbeat)',
    warning: reachable ? 'Engine degraded' : 'Engine unreachable',
    error: reachable ? 'Engine error' : 'Engine down',
    idle: 'Market closed',
  };

  if (loading) return null;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/60 transition-colors"
        title={label[health]}
      >
        <div className="relative flex items-center justify-center w-3 h-3">
          {health !== 'idle' && (
            <span
              className={cn(
                'absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping',
                pulseColor[health]
              )}
            />
          )}
          <span className={cn('relative inline-flex rounded-full h-2.5 w-2.5', dotColor[health])} />
        </div>
        <span className="text-xs text-slate-500 hidden sm:block">{label[health]}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-slate-200 bg-white shadow-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex rounded-full h-2.5 w-2.5', dotColor[health])} />
            <span className="text-sm font-semibold text-slate-800">{label[health]}</span>
          </div>

          {!reachable ? (
            <div className="space-y-2 text-xs text-slate-600">
              <p className="text-slate-500">
                Live endpoint unreachable at{' '}
                <span className="font-mono text-xs">{AUTO_TRADER_URL}</span>
              </p>
              {heartbeat && (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Last heartbeat</span>
                    <span className={cn(
                      'font-medium',
                      (Date.now() - new Date(heartbeat.last_seen_at).getTime()) / 60000 > 30
                        ? 'text-red-600' : 'text-slate-700'
                    )}>
                      {timeAgo(heartbeat.last_seen_at)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">IB connection</span>
                    <span className={cn('font-medium', heartbeat.ib_connected ? 'text-emerald-600' : 'text-slate-400')}>
                      {heartbeat.ib_connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Active trades</span>
                    <span className="font-medium">{heartbeat.active_trades}</span>
                  </div>
                  {heartbeat.last_cycle_result && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Last result</span>
                      <span className="font-medium text-right max-w-[160px] truncate">
                        {heartbeat.last_cycle_result}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : status ? (
            <div className="space-y-2 text-xs text-slate-600">
              <div className="flex justify-between">
                <span className="text-slate-400">Last cycle</span>
                <span className="font-medium">{timeAgo(status.lastRun)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Result</span>
                <span
                  className={cn(
                    'font-medium max-w-[160px] text-right truncate',
                    status.lastResult.startsWith('error') ? 'text-red-600' : 'text-slate-700'
                  )}
                >
                  {status.lastResult}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Cycles today</span>
                <span className="font-medium">{status.runCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">IB connection</span>
                <span
                  className={cn(
                    'font-medium',
                    status.ibConnected ? 'text-emerald-600' : 'text-slate-400'
                  )}
                >
                  {status.ibConnected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Scheduler</span>
                <span
                  className={cn(
                    'font-medium',
                    status.running ? 'text-emerald-600' : 'text-slate-400'
                  )}
                >
                  {status.running ? 'Active' : 'Paused'}
                </span>
              </div>
            </div>
          ) : null}

          <button
            onClick={() => fetchStatus()}
            className="w-full text-xs text-violet-600 hover:text-violet-700 font-medium pt-1 border-t border-slate-100"
          >
            Refresh status
          </button>
        </div>
      )}
    </div>
  );
}
