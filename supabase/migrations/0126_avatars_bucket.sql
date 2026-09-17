-- migration: 0126_avatars_bucket.sql
-- Adds a public `avatars` storage bucket for profile pictures.
--
-- User avatars are stored under <user-id>/<filename> with public read access.
-- The `profiles.avatar_url` column already exists (since 0001), so this migration
-- only creates the bucket and its policies.

-- Create the avatars bucket (public read)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true, -- public read
  2097152, -- 2MB limit
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- Storage policies: anyone can read, owner can write to their own folder
create policy "Avatar images are publicly accessible"
on storage.objects for select
using (bucket_id = 'avatars');

create policy "Users can upload avatars to their own folder"
on storage.objects for insert
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can update their own avatars"
on storage.objects for update
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can delete their own avatars"
on storage.objects for delete
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);
