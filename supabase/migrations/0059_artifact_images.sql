-- Artifact images: the storage half of "paste/attach an image into an artifact
-- body" (issue #90). When you drop an image into the artifact editor it uploads
-- here and a markdown `![](url)` link is inserted into the content.
--
-- Why a PUBLIC bucket (unlike the owner-private `files` bucket):
--   * The URL is baked into the artifact's markdown, which is stored and
--     re-rendered forever — a signed URL (7-day max) would break the image.
--   * An artifact can be made public (/share/a/:slug, /p/:slug), and its images
--     must load for anonymous visitors. A public bucket solves both the private
--     preview and the public-share case with one stable, non-expiring URL.
--   * Objects live under `<owner-id>/<uuid>/<name>`, so the path is unguessable
--     ("secret-URL" privacy, the same trust model as public artifact slugs and
--     webhook tokens). No sensitive data should be pasted into an artifact image
--     any more than into a public artifact.
--
-- Reads are public (bucket is public); writes/updates/deletes are scoped to the
-- uploader's own folder, exactly like the `files` bucket.

insert into storage.buckets (id, name, public)
values ('artifact-images', 'artifact-images', true)
on conflict (id) do nothing;

create policy "Members upload own artifact images"
  on storage.objects for insert
  with check (
    bucket_id = 'artifact-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Members replace own artifact images"
  on storage.objects for update
  using (
    bucket_id = 'artifact-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Members delete own artifact images"
  on storage.objects for delete
  using (
    bucket_id = 'artifact-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
