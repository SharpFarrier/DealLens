-- DealLens 5.0: the three-tab revamp. Run ONCE in the DispatchLens Supabase project, after 001, 002 and 003.
-- Adds deallens_* columns, one deallens_* table and three deallens_* functions. Changes nothing else.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Every price column in the sheet, per product, plus the sheet's Status text.
-- ---------------------------------------------------------------------------
alter table public.deallens_products
  add column if not exists prices jsonb not null default '{}'::jsonb,   -- {"New Price": 14699, "Price 11 Nov": 14999, ...}
  add column if not exists sheet_status text;

-- The price columns the sheet has (or had), and when DealLens first saw each one.
create table if not exists public.deallens_price_columns (
  name       text primary key,
  position   integer not null default 0,
  filled     integer not null default 0,
  total      integer not null default 0,
  present    boolean not null default true,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. The pricing rule: Sale (column minus %) or Normal day (exactly the column).
-- ---------------------------------------------------------------------------
alter table public.deallens_plan_settings
  add column if not exists mode text not null default 'sale',
  add column if not exists price_column text not null default 'New Price',
  add column if not exists price_column_by text,
  add column if not exists price_column_at timestamptz,
  add column if not exists dismissed_columns text[] not null default '{}';
do $$ begin
  alter table public.deallens_plan_settings add constraint deallens_plan_mode_chk check (mode in ('sale', 'normal'));
exception when duplicate_object then null; end $$;

-- Log the new rule fields too (the 003 trigger function, extended).
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
    if new.mode is distinct from old.mode then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'mode', 'Pricing mode', 'mode', old.mode, new.mode, who);
    end if;
    if new.price_column is distinct from old.price_column then
      insert into deallens_change_log(source, ref, label, field, old_value, new_value, changed_by)
      values ('plan', 'price_column', 'Selling price column', 'price_column', old.price_column, new.price_column, who);
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

-- ---------------------------------------------------------------------------
-- 3. Which listings count. A listing counts on a platform when the sheet has its ASIN / FSN,
--    unless the sheet's Status says that platform is pending (e.g. "Flipkart Pending").
-- ---------------------------------------------------------------------------
create or replace function public.deallens_counts_on(p_status text, p_platform text)
returns boolean language sql immutable
as $$ select coalesce(p_status, '') !~* (case when p_platform = 'amz' then 'amazon' else 'flipkart' end || '\s*pending') $$;

-- ---------------------------------------------------------------------------
-- 4. Live status history for the 30-day bars: per day (India time), platform and family,
--    how many listings were checked and how many were down. "Couldn't check" doesn't count either way.
--    Runs as the signed-in user, so the usual row level security applies.
-- ---------------------------------------------------------------------------
create or replace function public.deallens_status_days(p_days integer default 30)
returns table (day date, platform text, family text, checked integer, down integer)
language sql stable security invoker
set search_path = public
as $$
  with fam as (
    select * from (
      select distinct on (asin) 'amz'::text as platform, asin as id, family
        from deallens_products where asin is not null and deallens_counts_on(sheet_status, 'amz')
        order by asin, sort_order) a
    union all
    select * from (
      select distinct on (fsn) 'fk'::text, fsn, family
        from deallens_products where fsn is not null and deallens_counts_on(sheet_status, 'fk')
        order by fsn, sort_order) f
  ),
  hist as (
    select 'amz'::text as platform, asin as id, cls, checked_at from deallens_avail_history
      where checked_at >= now() - make_interval(days => p_days) and cls <> 'error'
    union all
    select 'fk', fsn, cls, checked_at from deallens_fk_avail_history
      where checked_at >= now() - make_interval(days => p_days) and cls <> 'error'
  ),
  last_of_day as (
    select distinct on (h.platform, h.id, (h.checked_at at time zone 'Asia/Kolkata')::date)
           h.platform, h.id, (h.checked_at at time zone 'Asia/Kolkata')::date as day, h.cls
      from hist h
      order by h.platform, h.id, (h.checked_at at time zone 'Asia/Kolkata')::date, h.checked_at desc
  )
  select l.day, l.platform, f.family, count(*)::integer, count(*) filter (where l.cls <> 'live')::integer
    from last_of_day l join fam f on f.platform = l.platform and f.id = l.id
   group by l.day, l.platform, f.family
$$;

-- ---------------------------------------------------------------------------
-- 5. Since when each listing that is down now has been down: the first non-live check after its
--    last live one. "Couldn't check" rows are ignored.
-- ---------------------------------------------------------------------------
create or replace function public.deallens_down_since()
returns table (platform text, id text, since timestamptz)
language sql stable security invoker
set search_path = public
as $$
  with cur as (
    select 'amz'::text as platform, asin as id from deallens_avail_checks where cls not in ('live', 'error')
    union all
    select 'fk', fsn from deallens_fk_avail_checks where cls not in ('live', 'error')
  ),
  hist as (
    select 'amz'::text as platform, asin as id, cls, checked_at from deallens_avail_history where cls <> 'error'
    union all
    select 'fk', fsn, cls, checked_at from deallens_fk_avail_history where cls <> 'error'
  ),
  last_live as (
    select platform, id, max(checked_at) as at from hist where cls = 'live' group by platform, id
  )
  select c.platform, c.id, min(h.checked_at)
    from cur c
    join hist h on h.platform = c.platform and h.id = c.id and h.cls <> 'live'
    left join last_live ll on ll.platform = c.platform and ll.id = c.id
   where ll.at is null or h.checked_at > ll.at
   group by c.platform, c.id
$$;

-- ---------------------------------------------------------------------------
-- 6. Access, like every other deallens_ table. Price columns are written only by the sheet sync (server).
-- ---------------------------------------------------------------------------
alter table public.deallens_price_columns enable row level security;
drop policy if exists deallens_read on public.deallens_price_columns;
create policy deallens_read on public.deallens_price_columns for select to authenticated using (public.deallens_can_access());

drop trigger if exists deallens_touch on public.deallens_price_columns;
create trigger deallens_touch after insert or update or delete on public.deallens_price_columns
  for each statement execute function public.deallens_touch();

-- Flipkart history is read by the functions above as the signed-in user.
alter table public.deallens_fk_avail_history enable row level security;
drop policy if exists deallens_read on public.deallens_fk_avail_history;
create policy deallens_read on public.deallens_fk_avail_history for select to authenticated using (public.deallens_can_access());

-- History rows get a touch too, so the 30-day bars refresh live after a check.
drop trigger if exists deallens_touch on public.deallens_avail_history;
create trigger deallens_touch after insert or update or delete on public.deallens_avail_history
  for each statement execute function public.deallens_touch();
drop trigger if exists deallens_touch on public.deallens_fk_avail_history;
create trigger deallens_touch after insert or update or delete on public.deallens_fk_avail_history
  for each statement execute function public.deallens_touch();

grant execute on function public.deallens_status_days(integer) to authenticated;
grant execute on function public.deallens_down_since() to authenticated;
grant execute on function public.deallens_counts_on(text, text) to authenticated;
