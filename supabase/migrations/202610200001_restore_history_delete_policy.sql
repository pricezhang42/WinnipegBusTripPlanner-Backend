-- Safe to reapply when the earlier history-deletion migration was missed or its
-- policy was removed. Ownership and RLS remain enforced; no history rows change.
begin;
grant delete on public.trip_history to authenticated;
drop policy if exists delete_own_history on public.trip_history;
create policy delete_own_history on public.trip_history
  for delete to authenticated using (user_id = (select auth.uid()));
commit;
