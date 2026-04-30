-- Heartbeat Staleness Checker — pg_cron (cloud-side safety net)
--
-- Checks every 10 minutes during market hours if the auto-trader heartbeat
-- is stale (last seen > 30 minutes ago). If stale, calls send-alert-email.
--
-- This catches the case where the Node.js service completely crashes —
-- the service-side dead man's switch can't fire if the process is dead.
-- Rate-limited to one alert per hour via system_heartbeats.last_alert_sent_at.
--
-- Requires: system_heartbeats table (20260430000001_system_heartbeat.sql)
-- Requires: pg_cron and pg_net extensions (already enabled by morning_brief migration)

create or replace function public.check_heartbeat_staleness()
returns void
language plpgsql
security definer
as $$
declare
  v_url           text;
  v_key           text;
  v_alert_email   text;
  v_last_seen     timestamptz;
  v_last_alert    timestamptz;
  v_stale_mins    numeric;
  v_et_now        timestamptz;
  v_et_hour       int;
  v_et_dow        int;  -- 0=Sun, 6=Sat
begin
  v_url := current_setting('app.supabase_url', true);
  v_key := current_setting('app.supabase_anon_key', true);
  if v_url is null or v_key is null then
    raise warning '[heartbeat] app.supabase_url or app.supabase_anon_key not set — skipping';
    return;
  end if;

  -- Only alert during market hours ET (9:30–17:00 Mon–Fri)
  -- pg uses server timezone; convert to ET
  v_et_now  := now() at time zone 'America/New_York';
  v_et_hour := extract(hour from v_et_now);
  v_et_dow  := extract(dow  from v_et_now);  -- 0=Sun, 6=Sat

  if v_et_dow in (0, 6) then return; end if;      -- weekends
  if v_et_hour < 9 or v_et_hour >= 17 then return; end if;  -- outside trading day
  if v_et_hour = 9 and extract(minute from v_et_now) < 30 then return; end if;

  -- Read heartbeat
  select last_seen_at, last_alert_sent_at
  into   v_last_seen, v_last_alert
  from   system_heartbeats
  where  id = 'auto-trader'
  limit  1;

  -- No heartbeat row at all → service never wrote one (treat as stale)
  if v_last_seen is null then
    v_stale_mins := 999;
  else
    v_stale_mins := extract(epoch from (now() - v_last_seen)) / 60;
  end if;

  -- Only alert if stale for > 30 minutes
  if v_stale_mins < 30 then return; end if;

  -- Rate-limit: don't send more than once per hour
  if v_last_alert is not null and (now() - v_last_alert) < interval '1 hour' then return; end if;

  -- Get alert email from config
  select alert_email
  into   v_alert_email
  from   auto_trader_config
  where  id = 'default'
  limit  1;

  if v_alert_email is null then return; end if;

  -- Update rate-limit timestamp before sending (prevents duplicate if function runs twice)
  update system_heartbeats
  set    last_alert_sent_at = now()
  where  id = 'auto-trader';

  -- Fire send-alert-email edge function
  perform net.http_post(
    url     := v_url || '/functions/v1/send-alert-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object(
      'alert_type', 'heartbeat_stale',
      'subject',    '🚨 Auto-Trader: Service appears to be down',
      'body',       format(
        E'The auto-trader heartbeat has not been updated for %s minutes.\n\nLast seen: %s ET\n\nThe service may have crashed. It should restart automatically via LaunchAgent.\n\nIf trades are open, check Interactive Brokers directly.',
        round(v_stale_mins)::text,
        to_char(v_last_seen at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI')
      ),
      'email_to',   v_alert_email
    )
  );
end;
$$;

-- Schedule: every 10 minutes during market hours (UTC: 13:00–21:00 = 9:00 AM–5:00 PM ET)
-- Using UTC range to cover both EST and EDT without timezone offset issues.
do $$
begin
  perform cron.unschedule('check-heartbeat-staleness');
exception when others then null;
end;
$$;

select cron.schedule(
  'check-heartbeat-staleness',
  '*/10 13-21 * * 1-5',
  'select public.check_heartbeat_staleness()'
);
