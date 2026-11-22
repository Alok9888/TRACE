-- =============================================================================
-- TRACE MCP API Keys Table
-- Stores one-way SHA-256 hashes of per-workspace MCP API keys (never plaintext).
-- =============================================================================

-- ---- UP ----
CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(24) NOT NULL,
    key_last4 VARCHAR(4) NOT NULL,
    label VARCHAR(100),
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_workspace_revoked
    ON mcp_api_keys (workspace_id, revoked);

-- ---- DOWN ----
-- DROP TABLE IF EXISTS mcp_api_keys;
