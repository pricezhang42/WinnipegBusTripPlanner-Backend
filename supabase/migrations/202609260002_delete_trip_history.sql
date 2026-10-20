-- Allow signed-in users to delete only their own history entries.
begin;
grant delete on public.trip_history to authenticated;
create policy delete_own_history on public.trip_history
  for delete to authenticated using (user_id = (select auth.uid()));
commit;
