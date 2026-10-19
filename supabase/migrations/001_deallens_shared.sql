-- DealLens on the DispatchLens Supabase project.
-- Run ONCE in the DispatchLens project: SQL Editor > New query > paste > Run.
-- Adds deallens_* tables and functions only. Does not change any DispatchLens table, policy or data.
-- Safe to re-run.
--
-- Who can use DealLens: anyone whose dispatch_user_access row is 'approved', on a device whose
-- approved_devices row is 'approved' (the owner account skips the device check, as in DispatchLens).
-- The DealLens browser app sends its device id in an "x-device-id" request header; the policies
-- below read it, so an approved person on an unapproved device gets nothing back.

-- ---------------------------------------------------------------------------
-- 1. Access checks
-- ---------------------------------------------------------------------------
create or replace function public.deallens_email()
returns text language sql stable
as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.deallens_is_owner()
returns boolean language sql stable
as $$ select public.deallens_email() = 'adityaramnani91581@gmail.com' $$;

-- Approved in DispatchLens (any permissions).
create or replace function public.deallens_is_member()
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.dispatch_user_access
    where lower(email) = public.deallens_email() and status = 'approved'
  );
$$;

-- The device id sent by the DealLens app with every database request.
create or replace function public.deallens_device_id()
returns text language sql stable
as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-device-id', '')
$$;

-- Member AND (owner OR this device is approved in DispatchLens's device list).
create or replace function public.deallens_can_access()
returns boolean language sql stable security definer
set search_path = public
as $$
  select public.deallens_is_member() and (
    public.deallens_is_owner()
    or exists (
      select 1 from public.approved_devices
      where device_id = public.deallens_device_id() and status = 'approved'
    )
  );
$$;

revoke all on function public.deallens_is_member() from public;
revoke all on function public.deallens_can_access() from public;
grant execute on function public.deallens_email(), public.deallens_is_owner(), public.deallens_device_id(),
  public.deallens_is_member(), public.deallens_can_access() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Catalogue (written only by the sheet sync, server-side)
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_products (
  key           text primary key,
  sort_order    integer not null,
  family        text not null,
  description   text not null,
  master_sku    text,
  amazon_sku    text,
  asin          text,
  flipkart_sku  text,
  flipkart_link text,
  fsn           text,
  new_price     numeric(12,2) not null,
  synced_at     timestamptz not null default now()
);
create index if not exists deallens_products_asin_idx on public.deallens_products (asin);

create table if not exists public.deallens_sync_runs (
  id           bigint generated always as identity primary key,
  trigger      text not null,
  triggered_by text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'ok', 'error')),
  row_count    integer,
  added        integer,
  removed      integer,
  changed      integer,
  error        text
);

-- ---------------------------------------------------------------------------
-- 3. Sale plan (edited by anyone with access)
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_plan_settings (
  id          smallint primary key default 1 check (id = 1),
  event       text not null default 'GIF 2026',
  disc        numeric(5,2) not null default 16 check (disc >= 0 and disc < 90),
  tol         numeric(8,2) not null default 1 check (tol >= 0),
  price_ref   text not null default 'deal' check (price_ref in ('deal', 'catalogue', 'off')),
  merchant_id text not null default 'A1VWJRNH9VRGHD',
  updated_by  text,
  updated_at  timestamptz not null default now()
);
insert into public.deallens_plan_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.deallens_family_discounts (
  family     text primary key,
  disc       numeric(5,2) not null check (disc >= 0 and disc < 90),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.deallens_sku_overrides (
  key        text primary key,
  price      numeric(12,2) not null check (price > 0),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.deallens_sku_excluded (
  key        text primary key,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Uploaded deal files (one current file per platform)
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_deal_files (
  platform    text primary key check (platform in ('amz', 'fk')),
  filename    text,
  aoa         jsonb not null,
  mapping     jsonb not null,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. Storefront checks (written server-side)
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_live_prices (
  platform   text not null check (platform in ('amz', 'fk')),
  id         text not null,
  price      numeric(12,2),
  err        text,
  checked_at timestamptz not null default now(),
  primary key (platform, id)
);

create table if not exists public.deallens_avail_checks (
  asin       text primary key,
  cls        text not null check (cls in ('live', 'variant', 'unavailable', 'nobuy', 'error')),
  served     text,
  price      numeric(12,2),
  seller     text,
  mid        text,
  err        text,
  checked_by text,
  checked_at timestamptz not null default now()
);

create table if not exists public.deallens_avail_history (
  id         bigint generated always as identity primary key,
  asin       text not null,
  cls        text not null,
  served     text,
  price      numeric(12,2),
  mid        text,
  err        text,
  checked_by text,
  checked_at timestamptz not null default now()
);
create index if not exists deallens_avail_history_asin_idx on public.deallens_avail_history (asin, checked_at desc);

-- ---------------------------------------------------------------------------
-- 6. Schedules (owner only)
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_config (
  key        text primary key,
  value      jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.deallens_config (key, value) values
  ('auto_sync', 'true'::jsonb),
  ('auto_live_status', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Change pings for live updates.
-- Realtime can't see the x-device-id header, so the data tables don't stream directly. Instead a
-- trigger stamps this small table (table name + time only, no business data) and the app refetches
-- the changed table through the normal, device-checked path.
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_changes (
  tbl        text primary key,
  changed_at timestamptz not null default now()
);

create or replace function public.deallens_touch()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.deallens_changes (tbl, changed_at) values (tg_table_name, now())
  on conflict (tbl) do update set changed_at = excluded.changed_at;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Row level security and triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'deallens_products','deallens_sync_runs','deallens_plan_settings','deallens_family_discounts',
    'deallens_sku_overrides','deallens_sku_excluded','deallens_deal_files','deallens_live_prices',
    'deallens_avail_checks','deallens_avail_history','deallens_config'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists deallens_read on public.%I', t);
    execute format('create policy deallens_read on public.%I for select to authenticated using (public.deallens_can_access())', t);
  end loop;

  foreach t in array array['deallens_plan_settings','deallens_family_discounts','deallens_sku_overrides','deallens_sku_excluded','deallens_deal_files'] loop
    execute format('drop policy if exists deallens_write on public.%I', t);
    execute format('create policy deallens_write on public.%I for all to authenticated using (public.deallens_can_access()) with check (public.deallens_can_access())', t);
  end loop;

  execute 'drop policy if exists deallens_owner_write on public.deallens_config';
  execute 'create policy deallens_owner_write on public.deallens_config for all to authenticated using (public.deallens_can_access() and public.deallens_is_owner()) with check (public.deallens_can_access() and public.deallens_is_owner())';

  -- Change pings: any approved DispatchLens user may see which table changed and when.
  execute 'alter table public.deallens_changes enable row level security';
  execute 'drop policy if exists deallens_changes_read on public.deallens_changes';
  execute 'create policy deallens_changes_read on public.deallens_changes for select to authenticated using (public.deallens_is_member())';

  foreach t in array array[
    'deallens_products','deallens_sync_runs','deallens_plan_settings','deallens_family_discounts',
    'deallens_sku_overrides','deallens_sku_excluded','deallens_deal_files','deallens_live_prices',
    'deallens_avail_checks','deallens_config'
  ] loop
    execute format('drop trigger if exists deallens_touch on public.%I', t);
    execute format('create trigger deallens_touch after insert or update or delete on public.%I for each statement execute function public.deallens_touch()', t);
  end loop;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deallens_changes'
  ) then
    execute 'alter publication supabase_realtime add table public.deallens_changes';
  end if;
end $$;
