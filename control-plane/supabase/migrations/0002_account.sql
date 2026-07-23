-- Customer account page (start.supanet.io/account.html): customers sign in to
-- the CONTROL-PLANE project with a Supabase email magic link, and RLS shows
-- them exactly the tenants whose admin_email matches their signed-in email.
-- No uuid-in-URL, nothing enumerable; write access stays service-role-only.

create policy tenants_owner_read on public.tenants
  for select to authenticated
  using (lower(admin_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Events stay private except through the tenant join the customer can read.
create policy cp_events_owner_read on public.cp_events
  for select to authenticated
  using (exists (
    select 1 from public.tenants t
    where t.id = cp_events.tenant_id
      and lower(t.admin_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));
