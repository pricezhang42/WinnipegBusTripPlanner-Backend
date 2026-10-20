-- Run once in the Supabase SQL editor, after 202609250001_saved_places_and_trips.sql.
-- Keeps one history entry per trip (same origin and destination, in that order).
-- Planning a trip again moves it to the top; the 10-entry limit counts distinct trips.
begin;
-- Endpoint key: [lon, lat] rounded to 4 decimals (about 11 m north-south, 7 m east-west
-- in Winnipeg), so small geocoder differences still match. Null when coordinates are invalid.
create function public.trip_point_key(p_location jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_location #> '{geometry,coordinates,0}') = 'number'
     and jsonb_typeof(p_location #> '{geometry,coordinates,1}') = 'number'
    then round((p_location #>> '{geometry,coordinates,0}')::numeric, 4)::text || ',' ||
         round((p_location #>> '{geometry,coordinates,1}')::numeric, 4)::text
  end
$$;
revoke all on function public.trip_point_key(jsonb) from public;

alter table public.trip_history add column trip_key text;
-- Rows without valid coordinates keep a unique key so they are never merged.
update public.trip_history set trip_key = coalesce(
  public.trip_point_key(origin) || '>' || public.trip_point_key(destination), 'invalid:' || id);
-- Existing duplicates: keep only the most recent entry for each trip.
delete from public.trip_history h using (
  select id, row_number() over (partition by user_id, trip_key order by created_at desc, id desc) as n
  from public.trip_history
) ranked where h.id = ranked.id and ranked.n > 1;
alter table public.trip_history alter column trip_key set not null;
alter table public.trip_history add constraint trip_history_user_trip unique (user_id, trip_key);

-- Same signature, so the app keeps calling it unchanged. RLS and grants are untouched.
create or replace function public.record_planned_trip(p_origin jsonb, p_destination jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  key text := public.trip_point_key(p_origin) || '>' || public.trip_point_key(p_destination);
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if key is null then raise exception 'Trip endpoints need valid coordinates'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  insert into public.trip_history(user_id, trip_key, origin, destination) values (uid, key, p_origin, p_destination)
  on conflict (user_id, trip_key) do update
    set origin = excluded.origin, destination = excluded.destination, created_at = now();
  delete from public.trip_history where user_id = uid and id not in (
    select id from public.trip_history where user_id = uid order by created_at desc, id desc limit 10
  );
end;
$$;
revoke all on function public.record_planned_trip(jsonb, jsonb) from public;
grant execute on function public.record_planned_trip(jsonb, jsonb) to authenticated;
commit;
