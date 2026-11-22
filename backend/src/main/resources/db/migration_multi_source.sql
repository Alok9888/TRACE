-- =============================================================================
-- TRACE Multi-Source RAG Migration
-- Supported source_type values: GITHUB_REPO, PDF, NOTEBOOK, IAC, EPUB
-- Reversible migration for PostgreSQL / Neon.
-- Note: Hibernate ddl-auto=update also adds nullable columns automatically,
-- and this script ensures existing rows are backfilled with source_type='GITHUB_REPO'
-- and adds the composite workspace/source_type index.
-- =============================================================================

-- ---- UP ----
ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'GITHUB_REPO',
    ADD COLUMN IF NOT EXISTS file_name VARCHAR(300),
    ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
    ADD COLUMN IF NOT EXISTS page_count INTEGER,
    ADD COLUMN IF NOT EXISTS storage_key VARCHAR(500),
    ADD COLUMN IF NOT EXISTS source_metadata_json TEXT;

UPDATE repositories
SET source_type = 'GITHUB_REPO'
WHERE source_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_repositories_user_source_type
    ON repositories (user_id, source_type);

-- ---- DOWN (Reversible rollback) ----
-- DROP INDEX IF EXISTS idx_repositories_user_source_type;
-- ALTER TABLE repositories
--     DROP COLUMN IF EXISTS source_metadata_json,
--     DROP COLUMN IF EXISTS storage_key,
--     DROP COLUMN IF EXISTS page_count,
--     DROP COLUMN IF EXISTS file_size_bytes,
--     DROP COLUMN IF EXISTS file_name,
--     DROP COLUMN IF EXISTS source_type;
