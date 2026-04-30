-- System Heartbeat Table
--
-- The auto-trader upserts a single row here every 60 seconds.
-- The dashboard reads this as a fallback when the HTTP endpoint is unreachable.
-- A pg_cron job checks staleness and fires send-alert edge function if dead.

create table if not exists system_heartbeats (
  id               text        primary key default 'auto-trader',
  last_seen_at     timestamptz not null default now(),
  status           text        not null default 'ok',  -- 'ok' | 'degraded' | 'error'
  ib_connected     boolean     not null default false,
  active_trades    int         not null default 0,
  last_cycle_result text,
  last_cycle_at    timestamptz,
  run_count        int         not null default 0,
  last_alert_sent_at timestamptz,                      -- rate-limits failure emails
  updated_at       timestamptz not null default now()
);

alter table system_heartbeats enable row level security;

-- Dashboard (anon/authenticated) can read
create policy "public read heartbeat"
  on system_heartbeats for select
  using (true);

-- Only service role can write (auto-trader uses service role key)
create policy "service write heartbeat"
  on system_heartbeats for all
  using (auth.role() = 'service_role');
