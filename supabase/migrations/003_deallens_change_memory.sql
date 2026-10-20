-- DealLens 4.2: change memory. Run ONCE in the DispatchLens Supabase project, after 001 and 002.
-- Adds a change log and "previous value" columns to deallens_* tables only. Changes nothing else.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. The change log: one row per thing that changed, kept forever.
-- ---------------------------------------------------------------------------
create table if not exists public.deallens_change_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  source     text not null check (source in ('amz_status','fk_status','amz_price','fk_price','sheet','deal_file','plan')),
  item_key   text,          -- catalogue key when known
  ref        text,          -- ASIN, FSN, family, platform or setting name
  label      text,          -- product or thing name, for display
  field      text,          -- what changed (status, price, new_price, deal, discount, ...)
  old_value  text,
  new_value  text,
  changed_by text           -- email, 'schedule', 'sheet sync'
);
create index if not exists deallens_change_log_at_idx on public.deallens_change_log (at desc);
create index if not exists deallens_change_log_key_idx on public.deallens_change_log (item_key, at desc);

-- ---------------------------------------------------------------------------
-- 2. "Previous check" values, so each row can show old -> new.
-- ---------------------------------------------------------------------------
alter table public.deallens_avail_checks
  add column if not exists prev_cls text,
  add column if not exists prev_price numeric(12,2),
  add column if not exists prev_served text,
  add column if not exists prev_checked_at timestamptz,
  add column if not exists changed boolean not null default false;

alter table public.deallens_fk_avail_checks
  add column if not exists prev_cls text,
  add column if not exists prev_price numeric(12,2),
  add column if not exists prev_served text,
  add column if not exists prev_checked_at timestamptz,
  add column if not exists changed boolean not null default false;

alter table public.deallens_live_prices
  add column if not exists prev_price numeric(12,2),
  add column if not exists prev_checked_at timestamptz;

alter table public.deallens_products
  add column if not exists prev jsonb,               -- the fields that changed, with their old values
  add column if not exists changed_at timestamptz,   -- set when the latest sync added or changed this row
  add column if not exists change_kind text;         -- 'added' | 'changed'

alter table public.deallens_deal_files
  add column if not exists prev_aoa jsonb,
  add column if not exists prev_mapping jsonb,
  add column if not exists prev_filename text,
  add column if not exists prev_uploaded_by text,
  add column if not exists prev_uploaded_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Plan edits are logged by the database itself, so every edit is recorded however it was made.
-- ---------------------------------------------------------------------------
-- Display helpers: 16.00 -> '16%', 7900.00 -> '₹7,900' (Indian grouping).
create or replace function public.deallens_pct(v numeric) returns text language sql immutable
as $$ select trim_scale(v)::text || '%' $$;
create or replace function public.deallens_inr(v numeric) returns text language plpgsql immutable
as $$
declare whole text := trunc(v)::bigint::text; frac numeric := v - trunc(v); out text; head text;
begin
  if length(whole) > 3 then
    head := left(whole, length(whole) - 3);
    out := right(whole, 3);
    while length(head) > 2 loop out := right(head, 2) || ',' || out; head := left(head, length(head) - 2); end loop;
    out := head || ',' || out;
  else out := whole; end if;
  if frac <> 0 then out := out || '.' || lpad((round(frac * 100))::int::text, 2, '0'); end if;
  return '₹' || out;
end $$;

create or replace function public.deallens_log_plan()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare who text := coalesce(nullif(public.deallens_email(), ''), 'server');
begin
  if tg_table_name = 'deallens_plan_settings' then
    if new.event is distinct from old.event then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'event', 'Sale name', 'event', old.event, new.event, who);
    end if;
    if new.disc is distinct from old.disc then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'disc', 'Sale discount', 'discount', public.deallens_pct(old.disc), public.deallens_pct(new.disc), who);
    end if;
    if new.tol is distinct from old.tol then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'tol', 'Match tolerance', 'tolerance', public.deallens_inr(old.tol), public.deallens_inr(new.tol), who);
    end if;
    if new.price_ref is distinct from old.price_ref then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'price_ref', 'Compare price to', 'price_ref', old.price_ref, new.price_ref, who);
    end if;
    if new.merchant_id is distinct from old.merchant_id then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'merchant_id', 'Amazon merchant ID', 'merchant_id', old.merchant_id, new.merchant_id, who);
    end if;
  elsif tg_table_name = 'deallens_family_discounts' then
    if tg_op = 'DELETE' then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', old.family, old.family || ' family', 'family_discount', public.deallens_pct(old.disc), 'sale default', who);
    elsif tg_op = 'INSERT' or new.disc is distinct from old.disc then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', new.family, new.family || ' family', 'family_discount',
              case when tg_op = 'INSERT' then 'sale default' else public.deallens_pct(old.disc) end, public.deallens_pct(new.disc), who);
    end if;
  elsif tg_table_name = 'deallens_sku_overrides' then
    if tg_op = 'DELETE' then
      insert into deallens_change_log(source, item_key, ref, field, old_value, new_value, changed_by)
      values ('plan', old.key, old.key, 'override', public.deallens_inr(old.price), 'from discount %', who);
    elsif tg_op = 'INSERT' or new.price is distinct from old.price then
      insert into deallens_change_log(source, item_key, ref, field, old_value, new_value, changed_by)
      values ('plan', new.key, new.key, 'override',
              case when tg_op = 'INSERT' then 'from discount %' else public.deallens_inr(old.price) end, public.deallens_inr(new.price), who);
    end if;
  elsif tg_table_name = 'deallens_sku_excluded' then
    if tg_op = 'INSERT' then
      insert into deallens_change_log(source, item_key, ref, field, old_value, new_value, changed_by)
      values ('plan', new.key, new.key, 'in_sale', 'in sale', 'excluded', who);
    elsif tg_op = 'DELETE' then
      insert into deallens_change_log(source, item_key, ref, field, old_value, new_value, changed_by)
      values ('plan', old.key, old.key, 'in_sale', 'excluded', 'in sale', who);
    end if;
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['deallens_plan_settings','deallens_family_discounts','deallens_sku_overrides','deallens_sku_excluded'] loop
    execute format('drop trigger if exists deallens_log_plan on public.%I', t);
    execute format('create trigger deallens_log_plan after insert or update or delete on public.%I for each row execute function public.deallens_log_plan()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Access: readable like every other deallens_ table. The browser may only add deal-file entries,
--    and only under its own email; everything else is written by the server or the triggers above.
-- ---------------------------------------------------------------------------
alter table public.deallens_change_log enable row level security;
drop policy if exists deallens_read on public.deallens_change_log;
create policy deallens_read on public.deallens_change_log for select to authenticated using (public.deallens_can_access());
drop policy if exists deallens_deal_file_log on public.deallens_change_log;
create policy deallens_deal_file_log on public.deallens_change_log for insert to authenticated
  with check (public.deallens_can_access() and source = 'deal_file' and changed_by = public.deallens_email());

drop trigger if exists deallens_touch on public.deallens_change_log;
create trigger deallens_touch after insert or update or delete on public.deallens_change_log
  for each statement execute function public.deallens_touch();
