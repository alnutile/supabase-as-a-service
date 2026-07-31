-- Public files: the "make a file public" half of the Files feature. A user can
-- publish a file so it gets a STABLE, non-expiring, anonymous URL — for baking
-- image URLs into a public artifact / static HTML page (which re-renders forever
-- and must load for anonymous visitors), the same need `artifact-images` solves.
--
-- Why a separate PUBLIC bucket (the `files` bucket stays owner-private):
--   * Supabase serves `getPublicUrl` only from a public bucket; a private bucket
--     can only mint expiring signed URLs (7-day max), which break a baked-in URL.
--   * Publishing COPIES the object here rather than exposing the private bucket,
--     so ordinary signed-link sharing (1h/1d/1w) and the private raw blob are
--     untouched — only files a user explicitly publishes ever leave the private
--     bucket.
--   * Objects live under `<owner-id>/<uuid>/<name>` (mirroring the private path),
--     so the URL is unguessable ("secret-URL" privacy — the same trust model as
--     public artifact slugs, artifact images, and webhook tokens). Nothing
--     sensitive should be published here any more than into a public artifact.
--
-- Reads are public (bucket is public); writes/updates/deletes are scoped to the
-- uploader's own folder, exactly like the `files` and `artifact-images` buckets.

insert into storage.buckets (id, name, public)
values ('public-files', 'public-files', true)
on conflict (id) do nothing;

create policy "Members upload own public files"
  on storage.objects for insert
  with check (
    bucket_id = 'public-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Members replace own public files"
  on storage.objects for update
  using (
    bucket_id = 'public-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Members delete own public files"
  on storage.objects for delete
  using (
    bucket_id = 'public-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- The object path within `public-files` when a file is published (else null).
-- Non-null == the file is public; its stable URL is
-- storage.from('public-files').getPublicUrl(public_path). Distinct from the
-- signed-link sharing that only flips `files.visibility` to 'unlisted'.
alter table public.files add column if not exists public_path text;
