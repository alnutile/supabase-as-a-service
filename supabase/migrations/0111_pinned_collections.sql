-- Add pinned column to collections table
-- Allows users to pin collections to the Home page for quick access

ALTER TABLE collections
ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for efficiently querying pinned collections
CREATE INDEX IF NOT EXISTS collections_pinned_idx
ON collections(owner_id, pinned, updated_at DESC)
WHERE pinned = TRUE;

-- Add comment for documentation
COMMENT ON COLUMN collections.pinned IS 'Whether this collection is pinned to the user''s Home page';
