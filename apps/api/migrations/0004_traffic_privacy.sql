-- ---------------------------------------------------------------------------
-- Traffic log detail and runtime settings.
--
-- Adds the fields the default log set is expected to carry (destination port
-- and duration) and a settings store, so full URL logging can be switched on
-- deliberately in the UI rather than only through a container restart.
-- ---------------------------------------------------------------------------

alter table traffic_events
  add column destination_port integer,
  add column duration_ms      integer;

-- provider_key stays and stays nullable on purpose. Squid's access log carries
-- the username but not the provider that accepted it, so the column is only
-- populated once an instrumented authentication helper can report it. It is
-- deliberately absent from the UI: a permanently empty filter is worse than no
-- filter.
comment on column traffic_events.provider_key is
  'Reserved. Only populated when the authentication helper reports the provider.';

create table app_settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Recording full URLs is a deliberate decision with a privacy cost, so the
-- default is off and the environment only supplies the initial value.
insert into app_settings (key, value)
values ('traffic.logUrls', 'false'::jsonb)
on conflict (key) do nothing;
