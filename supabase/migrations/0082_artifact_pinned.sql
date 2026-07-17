-- Add pinned column to artifacts table
-- Allows users to pin artifacts to the Home page for quick access

ALTER TABLE artifacts
ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for efficiently querying pinned artifacts
CREATE INDEX IF NOT EXISTS artifacts_pinned_idx
ON artifacts(owner_id, pinned, updated_at DESC)
WHERE pinned = TRUE;

-- Add comment for documentation
COMMENT ON COLUMN artifacts.pinned IS 'Whether this artifact is pinned to the user''s Home page';
