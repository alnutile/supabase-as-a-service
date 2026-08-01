-- Prevent a custom tool from shadowing a built-in of the same name.
--
-- Tool dispatch in every agent loop resolves a called tool name by checking
-- HTTP/custom tools BEFORE built-ins. So a custom tool named identically to a
-- built-in (e.g. an `http` `create_artifact` pointing at the REST API) silently
-- wins everywhere — chat, Slack, scheduler, webhooks — with nothing to warn the
-- admin. That is exactly how a workspace ended up calling a broken REST
-- `create_artifact` (401, missing bearer) instead of the built-in that writes
-- straight to the DB.
--
-- This is a data-integrity rule, so enforce it at the DB layer where it covers
-- ALL creation paths (the create_http_tool builtin, the Tools-page UI insert,
-- and Forge's tool registration) rather than in any single handler. A non-builtin
-- row whose name matches an existing is_builtin tool is rejected on insert/update.
-- Built-in rows themselves are exempt (that's how the seeds work), and pre-existing
-- collisions are left untouched — this only blocks NEW shadowing.
create or replace function public.prevent_builtin_tool_shadow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_builtin then
    return new;
  end if;
  if exists (
    select 1 from public.tools t
    where t.name = new.name and t.is_builtin and t.id <> new.id
  ) then
    raise exception
      'A built-in tool named "%" already exists; a custom tool cannot reuse that name (it would shadow the built-in). Choose a different name.',
      new.name
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_builtin_tool_shadow on public.tools;
create trigger prevent_builtin_tool_shadow
  before insert or update on public.tools
  for each row execute function public.prevent_builtin_tool_shadow();
