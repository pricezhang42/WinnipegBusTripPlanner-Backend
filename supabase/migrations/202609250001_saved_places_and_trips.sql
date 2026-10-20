-- Run once in the Supabase SQL editor for this app's project.
begin;
create table public.favorite_locations (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  location_key text not null,
  location jsonb not null check (jsonb_typeof(location) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, location_key)
);
create table public.favorite_trips (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  trip_key text not null,
  origin jsonb not null check (jsonb_typeof(origin) = 'object'),
  destination jsonb not null check (jsonb_typeof(destination) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, trip_key)
);
create table public.trip_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  origin jsonb not null check (jsonb_typeof(origin) = 'object'),
  destination jsonb not null check (jsonb_typeof(destination) = 'object'),
  created_at timestamptz not null default now()
);
create index trip_history_user_recent on public.trip_history(user_id, created_at desc, id desc);
alter table public.favorite_locations enable row level security;
alter table public.favorite_trips enable row level security;
alter table public.trip_history enable row level security;
create policy own_locations on public.favorite_locations for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_trips on public.favorite_trips for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_history on public.trip_history for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.favorite_locations, public.favorite_trips, public.trip_history from anon, authenticated;
grant select, insert, update, delete on public.favorite_locations, public.favorite_trips to authenticated;
grant select on public.trip_history to authenticated;
-- Only this function may write history. Serialize writes per user across devices.
create function public.record_planned_trip(p_origin jsonb, p_destination jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  insert into public.trip_history(user_id, origin, destination) values (uid, p_origin, p_destination);
  delete from public.trip_history where user_id = uid and id not in (
    select id from public.trip_history where user_id = uid order by created_at desc, id desc limit 10
  );
end;
$$;
revoke all on function public.record_planned_trip(jsonb, jsonb) from public;
grant execute on function public.record_planned_trip(jsonb, jsonb) to authenticated;
commit;
