-- Run every 15 minutes: ask the Edge Function to look for new articles and push them.
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'kpop-check',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://oflhzazgxhzvxobhxhfn.supabase.co/functions/v1/push/check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.push_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
