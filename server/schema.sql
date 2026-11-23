-- Run on the self-hosted Supabase (https://supabase.erichenry.com), in Studio → SQL
-- Editor or with `docker exec -i supabase-db psql -U postgres < schema.sql`. Safe to
-- re-run. Then make sure `plunge` is in PGRST_DB_SCHEMAS in ~/supabase-project/.env
-- and run `sh run.sh recreate rest` so the API serves this schema.
--
-- Access model: only the edge function, as the service role, reads or writes. Row-level
-- security is on with no policies, and the public roles get no grants.

create schema if not exists plunge;
grant usage on schema plunge to service_role;

-- What sources forget, one row per spot, kind (waterQuality, waves, waterLevelForecast, rain),
-- date and local hour, with the reading as JSON. Before this schema the table was public.plunge_history;
-- move it here, rows and all, if it’s still there.
do $$
begin
  if to_regclass('public.plunge_history') is not null and to_regclass('plunge.history') is null then
    alter table public.plunge_history set schema plunge;
    alter table plunge.plunge_history rename to history;
    alter index plunge.plunge_history_pkey rename to history_pkey;
  end if;
end;
$$;

create table if not exists plunge.history (
  spot text not null,
  kind text not null,
  date date not null,
  hour smallint not null check (hour between 0 and 23),
  value jsonb not null,
  recorded_at timestamptz not null default now(),
  constraint history_pkey primary key (spot, kind, date, hour)
);

revoke all on plunge.history from anon, authenticated;
grant all on plunge.history to service_role;
alter table plunge.history enable row level security;
