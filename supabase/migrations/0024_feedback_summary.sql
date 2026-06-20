-- Admin-facing aggregate for the /feedback page.
--
-- profiles SELECT is own-row only (0001), so — like usage_summary — this
-- security-definer function summarizes message_feedback across the whole
-- workspace and resolves the rater's email server-side. Admin-only (raises
-- otherwise).
--
-- It deliberately does NOT return message content: chat messages are
-- owner-private by RLS, and feedback review shouldn't become a backdoor into
-- everyone's conversations. The volunteered note + category + rating is the
-- signal; the email lets an admin follow up.

create or replace function public.feedback_summary(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'admin only';
  end if;

  select jsonb_build_object(
    'days', p_days,
    'total', (select count(*) from public.message_feedback where created_at >= since),
    'up', (select count(*) from public.message_feedback where created_at >= since and rating = 'up'),
    'down', (select count(*) from public.message_feedback where created_at >= since and rating = 'down'),
    'by_category', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select coalesce(category, '(none)') as category, count(*) as count
        from public.message_feedback
        where created_at >= since
        group by category order by count(*) desc
      ) t
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select f.id, f.rating, f.category, f.note, f.agent_id,
               p.email, f.created_at
        from public.message_feedback f
        left join public.profiles p on p.id = f.owner_id
        where f.created_at >= since
        order by f.created_at desc
        limit 200
      ) t
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.feedback_summary(integer) from public, anon;
grant execute on function public.feedback_summary(integer) to authenticated;
