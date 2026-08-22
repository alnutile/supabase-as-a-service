-- Knowledge compiler — turn a collection from "storage you search" into
-- "understanding that is maintained".
--
-- The workspace already had every raw ingredient (files, links, messages,
-- artifacts, terminology, collections, agents). What it lacked was a COMPILED
-- layer: the default flow was "add information -> search for it later ->
-- generate an answer", which makes the model re-interpret raw documents on
-- every question. This migration adds the layer that flips that to
-- "add information -> interpret it -> link it -> update existing knowledge ->
-- flag conflicts -> produce a brief".
--
-- The distinction that matters: a raw file is no longer an answer. It is
-- EVIDENCE. The answer lives on a compiled page, and every compiled claim keeps
-- a pointer back to the evidence it came from.
--
--   compile_policies    per-collection: what compiles together, and how freely.
--                       THE TRUST BOUNDARY — compilation is not unrestricted
--                       autonomous editing.
--   knowledge_pages     the compiled layer (concept/decision/process/person/
--                       project/terminology/principle/question/profile), with a
--                       lifecycle status and a human-confirmed flag.
--   knowledge_claims    atomic statements with provenance: which source, when
--                       captured, how confident, and whether a human confirmed.
--   knowledge_links     explicit relationships between pages, sources and rows.
--   knowledge_conflicts contradictions surfaced for a HUMAN to resolve. The
--                       compiler never silently picks a winner.
--   compile_runs        one compilation pass + its change brief.
--
-- Access mirrors collections/links/todos throughout: `private` (owner + admins)
-- or `workspace` (every member reads and collaborates). The compile function
-- runs as the service role, so it re-enforces the same rule in code.

-- ---------------------------------------------------------------------------
-- compile_policies — one row per collection
-- ---------------------------------------------------------------------------
create table if not exists public.compile_policies (
  collection_id uuid primary key references public.collections (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Normalized + validated in code by _shared/compiler.ts normalizePolicy(); the
  -- jsonb shape keeps the policy vocabulary (source kinds, page kinds, never-auto
  -- guards) extensible without a migration per new kind.
  policy jsonb not null default '{}'::jsonb,
  last_compiled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.compile_policies enable row level security;
grant select, insert, update, delete on public.compile_policies to authenticated;

-- A policy is visible / editable exactly when its collection is collaborable.
drop policy if exists "Read policies of visible collections" on public.compile_policies;
create policy "Read policies of visible collections"
  on public.compile_policies for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

drop policy if exists "Manage policies of collaborable collections" on public.compile_policies;
create policy "Manage policies of collaborable collections"
  on public.compile_policies for all
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  )
  with check (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

drop trigger if exists compile_policies_set_updated_at on public.compile_policies;
create trigger compile_policies_set_updated_at
  before update on public.compile_policies
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- knowledge_pages — the compiled layer
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  -- Stable upsert key (a slug of the title) so a REFINED page overwrites in
  -- place instead of minting a near-duplicate — the failure mode this whole
  -- feature exists to prevent.
  key text not null,
  kind text not null default 'concept'
    check (kind in ('concept','decision','process','person','project','terminology','principle','question','profile')),
  title text not null,
  summary text not null default '',
  content text not null default '',
  status text not null default 'compiled'
    check (status in ('processing','compiled','needs-review','contradicted','stale','confirmed','archived')),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  -- Human-confirmed pages are only ever APPENDED to automatically; rewriting one
  -- always goes through review (enforced in _shared/compiler.ts classifyUpdate).
  human_confirmed boolean not null default false,
  labels text[] not null default '{}',
  -- An optional durable artifact mirror, so a compiled page can keep a shareable
  -- URL and version history while the compiler maintains it in place.
  artifact_id uuid references public.artifacts (id) on delete set null,
  last_reviewed_at timestamptz,
  visibility text not null default 'private' check (visibility in ('private','workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One page per key per collection: this is what makes compilation idempotent.
create unique index if not exists knowledge_pages_key_idx
  on public.knowledge_pages (collection_id, key) where collection_id is not null;
create unique index if not exists knowledge_pages_owner_key_idx
  on public.knowledge_pages (owner_id, key) where collection_id is null;
create index if not exists knowledge_pages_collection_idx on public.knowledge_pages (collection_id, kind);
create index if not exists knowledge_pages_status_idx on public.knowledge_pages (owner_id, status);

alter table public.knowledge_pages enable row level security;
grant select, insert, update, delete on public.knowledge_pages to authenticated;

drop policy if exists "Read own or shared knowledge pages" on public.knowledge_pages;
create policy "Read own or shared knowledge pages"
  on public.knowledge_pages for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Insert own knowledge pages" on public.knowledge_pages;
create policy "Insert own knowledge pages"
  on public.knowledge_pages for insert
  with check (owner_id = auth.uid());

-- Workspace = collaborate: any member can confirm/correct a shared page. That is
-- the point — a human staying in the loop must not need to own the row.
drop policy if exists "Update own or shared knowledge pages" on public.knowledge_pages;
create policy "Update own or shared knowledge pages"
  on public.knowledge_pages for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Delete own knowledge pages" on public.knowledge_pages;
create policy "Delete own knowledge pages"
  on public.knowledge_pages for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop trigger if exists knowledge_pages_set_updated_at on public.knowledge_pages;
create trigger knowledge_pages_set_updated_at
  before update on public.knowledge_pages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- knowledge_claims — provenance for every compiled statement
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_claims (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  page_id uuid references public.knowledge_pages (id) on delete set null,
  statement text not null,
  -- Normalized statement used to avoid re-storing the same claim every run
  -- (claimFingerprint() in _shared/compiler.ts).
  fingerprint text not null,
  source_type text not null default 'manual'
    check (source_type in ('file','link','message','artifact','todo','meeting','note','manual')),
  source_id uuid,
  source_label text not null default '',
  captured_at timestamptz not null default now(),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  human_confirmed boolean not null default false,
  status text not null default 'active'
    check (status in ('active','superseded','contradicted','rejected')),
  superseded_by uuid references public.knowledge_claims (id) on delete set null,
  run_id uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists knowledge_claims_fingerprint_idx
  on public.knowledge_claims (owner_id, collection_id, fingerprint);
create index if not exists knowledge_claims_page_idx on public.knowledge_claims (page_id);
create index if not exists knowledge_claims_source_idx on public.knowledge_claims (source_type, source_id);

alter table public.knowledge_claims enable row level security;
grant select, insert, update, delete on public.knowledge_claims to authenticated;

-- A claim inherits its page's reach; free-floating claims are owner-only.
drop policy if exists "Read own or shared claims" on public.knowledge_claims;
create policy "Read own or shared claims"
  on public.knowledge_claims for select
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.knowledge_pages p
      where p.id = page_id and p.visibility = 'workspace'
    )
    or exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_admin)
  );

drop policy if exists "Insert own claims" on public.knowledge_claims;
create policy "Insert own claims" on public.knowledge_claims for insert with check (owner_id = auth.uid());

drop policy if exists "Update own claims" on public.knowledge_claims;
create policy "Update own claims"
  on public.knowledge_claims for update
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.knowledge_pages p where p.id = page_id and p.visibility = 'workspace')
    or exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_admin)
  );

drop policy if exists "Delete own claims" on public.knowledge_claims;
create policy "Delete own claims"
  on public.knowledge_claims for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_admin)
  );

-- ---------------------------------------------------------------------------
-- knowledge_links — explicit relationships
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  from_type text not null,
  from_id text not null,
  to_type text not null,
  to_id text not null,
  rel text not null default 'relates-to',
  run_id uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists knowledge_links_edge_idx
  on public.knowledge_links (owner_id, from_type, from_id, to_type, to_id, rel);
create index if not exists knowledge_links_from_idx on public.knowledge_links (from_type, from_id);
create index if not exists knowledge_links_to_idx on public.knowledge_links (to_type, to_id);

alter table public.knowledge_links enable row level security;
grant select, insert, update, delete on public.knowledge_links to authenticated;

drop policy if exists "Read own or shared knowledge links" on public.knowledge_links;
create policy "Read own or shared knowledge links"
  on public.knowledge_links for select
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.collections c where c.id = collection_id and c.visibility = 'workspace')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Insert own knowledge links" on public.knowledge_links;
create policy "Insert own knowledge links" on public.knowledge_links for insert with check (owner_id = auth.uid());

drop policy if exists "Delete own knowledge links" on public.knowledge_links;
create policy "Delete own knowledge links"
  on public.knowledge_links for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- ---------------------------------------------------------------------------
-- knowledge_conflicts — the review queue
-- ---------------------------------------------------------------------------
-- Contradiction detection is the biggest benefit AND the biggest risk. The rule
-- the whole design turns on: the compiler DETECTS a conflict and stops. It does
-- not choose which source is current. That judgment stays with a human, so a
-- conflict is a durable review item rather than a silent overwrite.
create table if not exists public.knowledge_conflicts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  page_id uuid references public.knowledge_pages (id) on delete set null,
  title text not null default 'Conflict',
  existing_text text not null default '',
  incoming_text text not null default '',
  impact text not null default '',
  suggested_action text not null default '',
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  -- `held` is the softer sibling of a true contradiction: an update the trust
  -- boundary declined to apply unattended, parked with the body it wanted to write.
  category text not null default 'conflict' check (category in ('conflict','held')),
  proposed jsonb,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution text not null default '',
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  source_ids text[] not null default '{}',
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_conflicts_open_idx
  on public.knowledge_conflicts (owner_id, status, created_at desc);
create index if not exists knowledge_conflicts_collection_idx on public.knowledge_conflicts (collection_id, status);

alter table public.knowledge_conflicts enable row level security;
grant select, insert, update, delete on public.knowledge_conflicts to authenticated;

drop policy if exists "Read own or shared conflicts" on public.knowledge_conflicts;
create policy "Read own or shared conflicts"
  on public.knowledge_conflicts for select
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.collections c where c.id = collection_id and c.visibility = 'workspace')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Insert own conflicts" on public.knowledge_conflicts;
create policy "Insert own conflicts" on public.knowledge_conflicts for insert with check (owner_id = auth.uid());

-- Resolving is the human's job, so any member of a shared collection may do it.
drop policy if exists "Resolve own or shared conflicts" on public.knowledge_conflicts;
create policy "Resolve own or shared conflicts"
  on public.knowledge_conflicts for update
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.collections c where c.id = collection_id and c.visibility = 'workspace')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Delete own conflicts" on public.knowledge_conflicts;
create policy "Delete own conflicts"
  on public.knowledge_conflicts for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop trigger if exists knowledge_conflicts_set_updated_at on public.knowledge_conflicts;
create trigger knowledge_conflicts_set_updated_at
  before update on public.knowledge_conflicts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- compile_runs — a pass and its change brief
-- ---------------------------------------------------------------------------
create table if not exists public.compile_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  status text not null default 'running' check (status in ('running','ok','error')),
  trigger text not null default 'manual' check (trigger in ('manual','event','schedule','tool')),
  sources_seen integer not null default 0,
  counts jsonb not null default '{}'::jsonb,
  brief text not null default '',
  -- Step-by-step checklist written as the run proceeds, so the UI can render a
  -- live pass (same pattern as security_scans.progress).
  progress jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  error text,
  cost numeric not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists compile_runs_recent_idx on public.compile_runs (owner_id, started_at desc);
create index if not exists compile_runs_collection_idx on public.compile_runs (collection_id, started_at desc);

alter table public.compile_runs enable row level security;
grant select, insert, update, delete on public.compile_runs to authenticated;

drop policy if exists "Read own or shared compile runs" on public.compile_runs;
create policy "Read own or shared compile runs"
  on public.compile_runs for select
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.collections c where c.id = collection_id and c.visibility = 'workspace')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Insert own compile runs" on public.compile_runs;
create policy "Insert own compile runs" on public.compile_runs for insert with check (owner_id = auth.uid());

drop policy if exists "Delete own compile runs" on public.compile_runs;
create policy "Delete own compile runs"
  on public.compile_runs for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Realtime: the Knowledge dashboard watches a running pass tick through its
-- steps and pops new conflicts into the review queue as they are found.
do $$
begin
  begin
    alter publication supabase_realtime add table public.compile_runs;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.knowledge_conflicts;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.knowledge_pages;
  exception when duplicate_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Events — the automation layer works in both directions
-- ---------------------------------------------------------------------------
-- A compiled page or a detected conflict emits an `events` row (0063), so a
-- listener can react: "when a conflict is detected, message me in Slack",
-- "when a brief lands, email it". Compilation is not a dead end.
create or replace function public.emit_knowledge_page_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'knowledge.page_created' else 'knowledge.page_updated' end,
    'knowledge_page', new.id, new.owner_id,
    case when tg_op = 'INSERT' then 'Compiled page created: ' else 'Compiled page updated: ' end || new.title,
    jsonb_build_object('kind', new.kind, 'status', new.status, 'collection_id', new.collection_id, 'key', new.key),
    case when new.visibility = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;

drop trigger if exists trg_emit_knowledge_page on public.knowledge_pages;
create trigger trg_emit_knowledge_page
  after insert or update of content, status on public.knowledge_pages
  for each row execute function public.emit_knowledge_page_event();

create or replace function public.emit_knowledge_conflict_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    'knowledge.conflict_detected',
    'knowledge_conflict', new.id, new.owner_id,
    'Conflict needs review: ' || new.title,
    jsonb_build_object('severity', new.severity, 'category', new.category, 'collection_id', new.collection_id),
    'workspace'
  );
  return new;
end; $$;

drop trigger if exists trg_emit_knowledge_conflict on public.knowledge_conflicts;
create trigger trg_emit_knowledge_conflict
  after insert on public.knowledge_conflicts
  for each row execute function public.emit_knowledge_conflict_event();

create or replace function public.emit_compile_run_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ok' and coalesce(old.status, '') <> 'ok' then
    perform public.emit_event(
      'knowledge.compiled',
      'compile_run', new.id, new.owner_id,
      'Compilation finished',
      jsonb_build_object('collection_id', new.collection_id, 'counts', new.counts, 'sources_seen', new.sources_seen),
      'workspace'
    );
  end if;
  return new;
end; $$;

drop trigger if exists trg_emit_compile_run on public.compile_runs;
create trigger trg_emit_compile_run
  after update of status on public.compile_runs
  for each row execute function public.emit_compile_run_event();

-- ---------------------------------------------------------------------------
-- Builtin tools — the compiler is drivable by chat, agents, and external Claude
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'compile_collection',
  'Run a knowledge-compilation pass over a collection: read the sources added since the last pass, extract claims, update the collection''s compiled pages, flag contradictions for human review, and return a change brief. Use this after new material lands in a collection — do NOT use it to answer a question.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id to compile."},"since":{"type":"string","description":"Optional ISO 8601 timestamp; only sources newer than this are compiled. Defaults to the last successful pass."},"dry_run":{"type":"boolean","description":"Analyze and report without writing any compiled page (default false)."}},"required":["collection"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'compile_collection');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_knowledge_pages',
  'List the workspace''s COMPILED knowledge pages (maintained understanding), newest first, with ids and status. Check here BEFORE searching raw documents — a compiled page is the maintained answer; raw files are the evidence behind it. Filter by collection, kind, status, or a title substring.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id."},"kind":{"type":"string","description":"Optional page kind: concept|decision|process|person|project|terminology|principle|question|profile."},"status":{"type":"string","description":"Optional status: compiled|needs-review|contradicted|stale|confirmed|archived."},"title_contains":{"type":"string","description":"Optional case-insensitive title substring."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_knowledge_pages');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_knowledge_page',
  'Read one compiled knowledge page in full, with the claims behind it and where each claim came from. Identify it by id, by key, or by exact title.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The page id."},"key":{"type":"string","description":"The page key (slug), alternative to id."},"title":{"type":"string","description":"The exact page title, alternative to id."},"include_claims":{"type":"boolean","description":"Include the provenance-bearing claims (default true)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_knowledge_page');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_knowledge_page',
  'Create or maintain a compiled knowledge page directly. Use `append` to add new understanding and `revise` to correct existing wording; write durable reference prose, not a summary of one document. Set confirmed:true only when a HUMAN has verified the page.',
  '{"type":"object","properties":{"title":{"type":"string","description":"The page title (used as its stable key when no id/key is given)."},"id":{"type":"string","description":"Optional existing page id."},"key":{"type":"string","description":"Optional existing page key."},"kind":{"type":"string","description":"concept|decision|process|person|project|terminology|principle|question|profile (default concept)."},"body":{"type":"string","description":"The markdown to append or to write."},"op":{"type":"string","description":"append (default) or revise."},"collection":{"type":"string","description":"Optional collection name or id to file the page under."},"summary":{"type":"string","description":"Optional one-line summary."},"labels":{"type":"array","items":{"type":"string"},"description":"Optional labels (e.g. \"client-facing\") that a collection policy can protect from automatic edits."},"confirmed":{"type":"boolean","description":"Mark the page human-confirmed."},"visibility":{"type":"string","description":"private (default) or workspace."}},"required":["body"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_knowledge_page');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_conflicts',
  'List open knowledge conflicts and held updates awaiting a human decision — contradictions between new evidence and compiled knowledge that the compiler deliberately refused to resolve on its own.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id."},"status":{"type":"string","description":"open (default), resolved, or dismissed."},"limit":{"type":"number","description":"Max rows (default 25, max 100)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_conflicts');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'resolve_conflict',
  'Record a HUMAN decision on a knowledge conflict. Only call this when the user has actually told you which source is current — never decide on their behalf. `apply` writes the held/incoming text onto the page; `keep` leaves the page as it is; `dismiss` closes it without a change.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The conflict id."},"decision":{"type":"string","description":"apply | keep | dismiss."},"note":{"type":"string","description":"Optional note recording the reasoning."}},"required":["id","decision"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'resolve_conflict');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_change_brief',
  'Read the change brief from a compilation pass: what was added, updated, linked, what became stale, what conflicts were found and what needs human review. Defaults to the most recent pass.',
  '{"type":"object","properties":{"run_id":{"type":"string","description":"Optional specific run id."},"collection":{"type":"string","description":"Optional collection name or id (defaults to the latest run in any collection)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_change_brief');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'set_compile_policy',
  'Set a collection''s compilation policy — the trust boundary for automatic knowledge editing. `autonomy` is suggest (nothing written unattended), guarded (new pages and additive appends apply; rewrites go to review — the default), or auto (rewrites apply too; wholesale replacement still needs a human). `never_auto` protects pages by kind, label or title substring (e.g. "financial commitments", "client-facing").',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"enabled":{"type":"boolean","description":"Turn compilation on or off for this collection."},"autonomy":{"type":"string","description":"suggest | guarded | auto."},"compile_sources":{"type":"array","items":{"type":"string"},"description":"Source kinds to compile: file|link|message|artifact|todo|meeting|note."},"maintain_kinds":{"type":"array","items":{"type":"string"},"description":"Page kinds this collection maintains."},"never_auto":{"type":"array","items":{"type":"string"},"description":"Guards matched against a page''s kind, labels or title — never edited automatically."},"min_confidence":{"type":"number","description":"Updates below this confidence go to review (0-1)."},"stale_days":{"type":"number","description":"A page not reviewed in this many days is flagged stale."}},"required":["collection"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'set_compile_policy');

-- ---------------------------------------------------------------------------
-- Always-on prompt — teach the compiler discipline
-- ---------------------------------------------------------------------------
insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin)
select
  (select id from public.profiles order by created_at asc limit 1),
  'Knowledge compiler',
  'Built-in. Teaches the assistant to answer from compiled knowledge pages first, treat raw files as evidence, and never resolve a contradiction on the user''s behalf.',
  $prompt$COMPILED KNOWLEDGE

This workspace maintains a COMPILED layer on top of its raw material. A compiled knowledge page (concept, decision, process, person, project, terminology, principle, question, profile) is the workspace's maintained understanding of a subject. Uploaded files, links, messages and transcripts are the EVIDENCE behind those pages — they are not themselves the answer.

Reading:
- When a question touches a subject the workspace tracks, look at the compiled pages first (`list_knowledge_pages`, `get_knowledge_page`).
- Fall back to `search_documents` over the raw sources when nothing is compiled yet, when you need a source's exact wording, or when a page is marked stale or contradicted.
- Never present a stale or contradicted page as current. Say what is disputed and why.

Writing:
- When new material arrives, fold it into the page that already covers the subject (`update_knowledge_page`, or `compile_collection` for a whole batch) rather than writing a fresh near-duplicate.
- A compiled page is durable reference prose describing what is currently true, with its evidence cited inline — not a summary of "what this document said".

Conflicts:
- If new evidence disagrees with a compiled page, do NOT pick a winner and do NOT quietly overwrite the page.
- Say plainly what the old and the new source each claim, what it puts at risk, and what the user needs to decide.
- Only call `resolve_conflict` once the user has actually told you which source is current. The human owns source selection and judgment.

Boundaries:
- Each collection has a compilation policy. Some pages are marked never-auto (financial commitments, client-facing documents, published content) and some are human-confirmed; those are appended to, never rewritten, without a person agreeing. Respect that even when you are confident.
- Compilation amplifies mistakes. A bad source in a search result is isolated; a bad source folded into compiled knowledge spreads into every answer built on it.$prompt$,
  true, true
where not exists (select 1 from public.skills where name = 'Knowledge compiler');
