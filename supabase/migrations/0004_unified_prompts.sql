-- Unify prompts & skills.
-- A row in `skills` is now either:
--   • Always-on  (auto_apply = true): workspace/system context prepended to
--     EVERY chat. Admin-managed. The built-in "How this workspace works" prompt
--     teaches the assistant what the system is and how to create artifacts.
--   • On-demand  (auto_apply = false): a personal skill invoked with `/`.

alter table public.skills
  add column if not exists auto_apply boolean not null default false,
  add column if not exists is_builtin boolean not null default false;

-- Built-in / always-on rows aren't owned by a single user.
alter table public.skills alter column owner_id drop not null;

-- Re-scope RLS: personal rows are owner-managed; always-on rows are readable by
-- everyone and writable only by admins.
drop policy if exists "Owners manage their skills" on public.skills;

create policy "Read own or always-on prompts"
  on public.skills for select
  using (owner_id = auth.uid() or auto_apply = true);

create policy "Insert own skill or admin always-on"
  on public.skills for insert
  with check (
    (auto_apply = false and owner_id = auth.uid())
    or (auto_apply = true and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  );

create policy "Update own skill or admin always-on"
  on public.skills for update
  using (
    (auto_apply = false and owner_id = auth.uid())
    or (auto_apply = true and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  )
  with check (
    (auto_apply = false and owner_id = auth.uid())
    or (auto_apply = true and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  );

create policy "Delete own skill or admin always-on"
  on public.skills for delete
  using (
    (auto_apply = false and owner_id = auth.uid())
    or (auto_apply = true and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  );

-- Seed the built-in system prompt (idempotent on name+is_builtin).
insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'How this workspace works',
  'Built-in. Explains the system to the assistant and is applied to every chat. Edit to taste.',
  $prompt$You are the assistant inside this Supabase-powered intranet. Help people think and build: documents, plans, code, small web pages, structured notes.

This system has:
- Chat (here): conversations are saved and sync live across devices.
- Artifacts: shareable documents you create — types: markdown, code, html, text. They can stay private or be shared by link / publicly.
- Files: users upload files and share them with links.
- Skills: saved instructions a user runs with "/".

CREATING AN ARTIFACT
When the user asks you to create, save, turn something into, or share an artifact (a doc, code file, HTML page, spec, etc.), output it as ONE block in EXACTLY this format:

:::artifact {"title":"Short descriptive title","type":"markdown"}
...the full content of the artifact...
:::

Rules:
- "type" must be one of: markdown, code, html, text.
- Put ONLY the artifact's content between the ::: fences — no commentary inside.
- You may add one short sentence before the block (e.g. "Here it is as a shareable artifact:").
- Do NOT wrap the :::artifact block in code fences, and don't explain the format.
The app automatically saves that block as an artifact and replaces it with a share link.

STYLE: be warm, concise, and practical. Use fenced code blocks (with a language tag) for code. Ask a clarifying question only when genuinely needed.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where is_builtin = true);
