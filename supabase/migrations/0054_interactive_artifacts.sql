-- ---------------------------------------------------------------------------
-- 0054 interactive artifacts
-- Makes `html` artifacts stateful and live, so the assistant can build
-- Claude.ai-style interactive trackers/dashboards the user can click
-- (checkboxes, status pills, notes) with the changes persisting.
--
-- Four pieces:
--   1. artifacts.data — a jsonb bucket for the artifact's saved UI state.
--      The sandboxed iframe can't use localStorage (opaque origin, on
--      purpose), so the page JS posts state to the parent app over a tiny
--      postMessage protocol and the PARENT (which holds the authed Supabase
--      client) writes it here under normal RLS. The artifact HTML never
--      touches credentials.
--   2. artifacts joins the realtime publication, so the chat side panel and
--      editor preview refresh live when the assistant (or another device)
--      updates a tracker mid-conversation.
--   3. get_artifact / update_artifact builtins — the assistant can read the
--      current version and evolve it in place instead of minting a duplicate
--      artifact every revision. Handlers live in
--      supabase/functions/_shared/builtins.ts (service role, so update
--      re-enforces owner-only in code).
--   4. A seeded always-on prompt teaching the assistant the bridge protocol
--      (its own auto_apply skill row, so admins can edit it without touching
--      the main "How this workspace works" prompt).
-- ---------------------------------------------------------------------------

alter table public.artifacts
  add column if not exists data jsonb not null default '{}'::jsonb;

-- Live updates for the chat panel / editor preview. RLS still applies to
-- realtime, so private artifacts only reach their owner.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'artifacts'
  ) then
    alter publication supabase_realtime add table public.artifacts;
  end if;
end $$;

-- get_artifact: read the current version (content + saved state) before editing.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_artifact',
  'Read one artifact by its id or exact title: returns the id, title, type, current content, and saved interactive state (data). Use this before update_artifact so you edit the latest version instead of guessing.',
  '{"type":"object","properties":{"artifact":{"type":"string","description":"The artifact id or its exact title."}},"required":["artifact"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_artifact');

-- update_artifact: evolve an artifact in place (the live views refresh via realtime).
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_artifact',
  'Update an artifact the user owns: replace its title and/or content, and optionally its saved interactive state (data). Pass only the fields to change — content replaces the WHOLE body, so call get_artifact first and send the complete new version. Open views update live. Usually leave "data" out so the user''s saved clicks/notes are preserved.',
  '{"type":"object","properties":{"artifact":{"type":"string","description":"The artifact id or its exact title."},"title":{"type":"string","description":"New title."},"content":{"type":"string","description":"The complete new content (replaces the old content)."},"data":{"type":"object","description":"Replaces the saved interactive state. Usually omit this."}},"required":["artifact"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_artifact');

-- Always-on prompt: teaches the assistant to build stateful html artifacts and
-- to revise them with get_artifact/update_artifact instead of duplicating.
insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'Interactive artifacts',
  'Built-in. Teaches the assistant how to build live, stateful HTML artifacts (trackers, dashboards, checklists) and update them in place.',
  $prompt$INTERACTIVE ARTIFACTS (live trackers, dashboards, checklists)

When the user wants something they can interact with and keep updated — a planning tracker, checklist, kanban, scorecard, dashboard — create an `html` artifact instead of markdown. Rules:

- Fully self-contained: inline CSS + JS, no external requests. It renders inside a sandboxed iframe.
- Render the whole UI from ONE `state` object (with sensible defaults for missing keys) and wire up persistence with exactly this bridge:

<script>
  let state = window.__ARTIFACT_DATA__ || {}   // saved state, when the standalone page injects it
  function save() { parent.postMessage({ type: 'artifact:save', data: state }, '*') }
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'artifact:state') { state = Object.assign({}, state, e.data.data); render() }
  })
  parent.postMessage({ type: 'artifact:ready' }, '*')
  render()
</script>

- Mutate `state` and call save() after every user change (a toggled checkbox, a status click, an edited note — debounce rapid typing). The app stores it in the artifact's `data` and sends it back on the next load, so changes survive reloads and sync across devices.
- Keep the document's structure and copy in the HTML itself; keep only the user's changes (ticks, statuses, notes) in `state`. Then the HTML can be revised later without losing what they saved.
- To revise an existing tracker in a later message: call get_artifact to read the current version, then update_artifact with the COMPLETE new content. Do not emit a new :::artifact block for a revision — that creates a duplicate. Leave `data` out of update_artifact so the user's saved state is kept.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where name = 'Interactive artifacts' and is_builtin = true);
