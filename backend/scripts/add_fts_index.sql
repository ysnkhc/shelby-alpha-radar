-- Full-Text Search Index Migration
-- Adds a GIN index on blob_metadata for fast full-text search over title + description.
-- This is applied AFTER the initial Prisma migration via: psql -f scripts/add_fts_index.sql

-- Create a generated tsvector column and GIN index for full-text search.
-- We use coalesce() to handle NULL values gracefully.

-- Step 1: Add the tsvector column
ALTER TABLE blob_metadata
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(description, '')
    )
  ) STORED;

-- Step 2: Create the GIN index on the tsvector column
CREATE INDEX IF NOT EXISTS idx_blob_metadata_search
  ON blob_metadata
  USING GIN (search_vector);
