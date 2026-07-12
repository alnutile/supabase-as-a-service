-- Make artifact images private with visibility tied to their artifact
-- (issue #157: GitHub-style privacy — images only visible when logged in
-- UNLESS the artifact is public)
--
-- Changes from 0059:
--   1. Bucket is now PRIVATE (not public)
--   2. Add artifact_id metadata to track ownership
--   3. RLS: read if owner OR artifact is public/unlisted
--   4. Frontend switches between signed URLs (private) and public URLs (when artifact public)

-- Switch bucket from public to private
update storage.buckets
set public = false
where id = 'artifact-images';

-- Add SELECT policy: owner can always read, OR anyone if the artifact is public/unlisted
-- (we'll store artifact_id in the object metadata)
create policy "Read own artifact images or public artifact images"
  on storage.objects for select
  using (
    bucket_id = 'artifact-images'
    and (
      -- Owner can always read their own images
      (storage.foldername(name))[1] = auth.uid()::text
      or
      -- Anyone can read if the artifact is public/unlisted
      exists (
        select 1 from artifacts
        where id::text = (metadata->>'artifact_id')
        and visibility in ('public', 'unlisted')
      )
    )
  );
