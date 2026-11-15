-- Subscriptions + config for K-Pop Tracker web push.
-- Only the Edge Function (service role) touches these tables.

create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  p256dh       text not null,
  auth         text not null,
  artists      text[] not null default '{}',
  last_checked timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table if not exists public.push_config (
  key   text primary key,
  value text not null
);

alter table public.push_subscriptions enable row level security;
alter table public.push_config enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_config from anon, authenticated;

-- Shared secret that lets pg_cron (and only pg_cron) trigger /check.
insert into public.push_config (key, value)
values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;
