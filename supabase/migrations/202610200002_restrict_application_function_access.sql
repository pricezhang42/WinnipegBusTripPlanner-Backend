-- Hosted projects may grant anon EXECUTE through default privileges. Revoking
-- PUBLIC alone does not remove an explicit anon grant inherited at creation.
-- Restrict only these application functions; leave platform defaults untouched.
begin;
revoke execute on function public.record_planned_trip(jsonb, jsonb) from public, anon;
revoke execute on function public.trip_point_key(jsonb) from public, anon;
grant execute on function public.record_planned_trip(jsonb, jsonb) to authenticated;
commit;
