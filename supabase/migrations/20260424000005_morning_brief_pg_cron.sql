-- Morning Brief — Cloud Scheduler
--
-- Runs generate-morning-brief edge function at 8 AM ET every weekday entirely in the cloud.
-- No laptop required. Uses pg_cron + pg_net.
--
-- SETUP (one-time): Before applying this migration, set your project URL & anon key:
--
--   ALTER DATABASE postgres SET app.supabase_url = 'https://YOUR_PROJECT_REF.supabase.co';
--   ALTER DATABASE postgres SET app.supabase_anon_key = 'YOUR_ANON_KEY';
--
-- Your project URL is in app/.env as VITE_SUPABASE_URL.
-- Your anon key is in app/.env as VITE_SUPABASE_ANON_KEY.
-- After setting these, apply this migration normally.

create extension if not exists pg_cron  with schema pg_catalog;
create extension if not exists pg_net   with schema extensions;

-- Wrapper function — keeps the URL/key in one easy-to-find place.
create or replace function private.trigger_morning_brief()
returns void
language plpgsql
security definer
as $$
declare
  v_url text;
  v_key text;
begin
  v_url := current_setting('app.supabase_url', true);
  v_key := current_setting('app.supabase_anon_key', true);

  if v_url is null or v_key is null then
    raise warning '[morning_brief] app.supabase_url or app.supabase_anon_key not set — skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/generate-morning-brief',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := '{}'::jsonb
  );
end;
$$;

-- Remove stale job if exists, then re-create cleanly.
do $$
begin
  perform cron.unschedule('morning-brief-daily');
exception when others then null;
end;
$$;

-- 12:00 UTC = 8:00 AM EDT (summer) / 7:00 AM EST (winter) — always within pre-market window.
select cron.schedule(
  'morning-brief-daily',
  '0 12 * * 1-5',
  'select private.trigger_morning_brief()'
);
