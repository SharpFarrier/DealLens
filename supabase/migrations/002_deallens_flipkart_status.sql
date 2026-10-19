-- DealLens 4.1: Flipkart Live status. Run ONCE in the DispatchLens Supabase project, after 001.
-- Adds two deallens_ tables only. Changes nothing else. Safe to re-run.

create table if not exists public.deallens_fk_avail_checks (
  fsn        text primary key,
  cls        text not null check (cls in ('live', 'variant', 'unavailable', 'nobuy', 'error')),
  served     text,
  price      numeric(12,2),
  avail      text,
  err        text,
  checked_by text,
  checked_at timestamptz not null default now()
);

create table if not exists public.deallens_fk_avail_history (
  id         bigint generated always as identity primary key,
  fsn        text not null,
  cls        text not null,
  served     text,
  price      numeric(12,2),
  avail      text,
  err        text,
  checked_by text,
  checked_at timestamptz not null default now()
);
create index if not exists deallens_fk_avail_history_fsn_idx on public.deallens_fk_avail_history (fsn, checked_at desc);

do $$
declare t text;
begin
  foreach t in array array['deallens_fk_avail_checks','deallens_fk_avail_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists deallens_read on public.%I', t);
    execute format('create policy deallens_read on public.%I for select to authenticated using (public.deallens_can_access())', t);
  end loop;
  execute 'drop trigger if exists deallens_touch on public.deallens_fk_avail_checks';
  execute 'create trigger deallens_touch after insert or update or delete on public.deallens_fk_avail_checks for each statement execute function public.deallens_touch()';
end $$;
