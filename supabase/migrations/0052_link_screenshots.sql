-- Link screenshots: the storage half of links.screenshot_path (reserved in
-- 0049). Screenshots live in a dedicated private bucket, NOT the `files`
-- bucket — files are owner-private by folder, but a screenshot belongs to the
-- link (which can be workspace-shared), so any signed-in member may read
-- these objects and the UI shows them via short-lived signed URLs.
--
-- Writes come from the service role (the set_link_screenshot builtin, future
-- capture pipelines) or a member uploading into their own folder. The seeded
-- `set_link_screenshot` builtin takes an image URL (e.g. produced by a
-- browse-the-web capture) and stores it: download → bucket → screenshot_path.

insert into storage.buckets (id, name, public)
values ('link-screenshots', 'link-screenshots', false)
on conflict (id) do nothing;

-- Any member can view (screenshots of shareable links are workspace-visible).
create policy "Members read link screenshots"
  on storage.objects for select
  using (bucket_id = 'link-screenshots' and auth.role() = 'authenticated');

-- Members write only into their own folder (the service role bypasses RLS).
create policy "Members upload own link screenshots"
  on storage.objects for insert
  with check (
    bucket_id = 'link-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Members replace own link screenshots"
  on storage.objects for update
  using (
    bucket_id = 'link-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Members delete own link screenshots"
  on storage.objects for delete
  using (
    bucket_id = 'link-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Seed the builtin (idempotent, same shape as the other link tools).
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'set_link_screenshot',
  'Attach a screenshot to a saved link: pass the link id and the URL of a captured screenshot image. The image is downloaded and stored in the workspace; the Links page then shows it as the link''s preview.',
  '{"type":"object","required":["link_id","image_url"],"properties":{"link_id":{"type":"string","description":"The saved link''s id (from save_link / list_links)."},"image_url":{"type":"string","description":"URL of the screenshot image to download and store."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'set_link_screenshot');
