-- Reusable AI summaries: one cached result per caller/resource version/style.
-- The summarize_resource builtin is callable from chat/agents, run-tool, and
-- event listeners. Source access is re-enforced in the builtin because agent
-- loops execute with the service role. Cached summaries remain owner-private.

create table public.resource_summaries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('link', 'file', 'artifact', 'inbox_message', 'knowledge_page', 'text')),
  source_id text not null,
  source_version text not null,
  style text not null default 'tldr' check (style in ('tldr', 'brief', 'detailed')),
  max_words integer not null default 80 check (max_words between 20 and 500),
  summary text not null,
  model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_kind, source_id, source_version, style, max_words)
);
create index resource_summaries_owner_idx on public.resource_summaries (owner_id, updated_at desc);

alter table public.resource_summaries enable row level security;
grant select, delete on public.resource_summaries to authenticated;
create policy "owners read summaries" on public.resource_summaries for select
  using (owner_id = auth.uid());
create policy "owners delete summaries" on public.resource_summaries for delete
  using (owner_id = auth.uid());

create or replace function public.emit_resource_summary_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'summary.created' else 'summary.updated' end,
    'resource_summary', new.id, new.owner_id,
    'Summary generated for ' || new.source_kind,
    jsonb_build_object('source_kind', new.source_kind, 'source_id', new.source_id, 'style', new.style),
    'private'
  );
  return new;
end; $$;
revoke execute on function public.emit_resource_summary_event() from anon, authenticated, public;
create trigger trg_emit_resource_summary
  after insert or update on public.resource_summaries
  for each row execute function public.emit_resource_summary_event();

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'summarize_resource',
  'Generate a cached AI summary of a workspace resource. Works with links (including Dropbox files), workspace files, artifacts, inbox messages, compiled knowledge pages, or supplied text. Can safely write the result to a link or file description. Usable by agents, run-tool, schedules, and event listeners.',
  '{"type":"object","properties":{"source_kind":{"type":"string","enum":["link","file","artifact","inbox_message","knowledge_page","text"],"description":"Kind of resource to summarize."},"source_id":{"type":"string","description":"Resource id. Required except for source_kind=text."},"text":{"type":"string","description":"Direct content when source_kind=text."},"title":{"type":"string","description":"Optional label for direct text."},"style":{"type":"string","enum":["tldr","brief","detailed"],"description":"Summary depth; defaults to tldr."},"max_words":{"type":"integer","minimum":20,"maximum":500,"description":"Maximum words in the summary."},"refresh":{"type":"boolean","description":"Ignore a matching cached summary and regenerate."},"write_back":{"type":"boolean","description":"Write the summary to the description field for link/file sources."}},"required":["source_kind"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'summarize_resource');
