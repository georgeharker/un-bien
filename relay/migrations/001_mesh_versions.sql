-- Plan 24: Owner-signed membership versions persisted at the relay.
-- One row per Owner (identified by sha256(owner_pk)). UPSERT-based —
-- only the most recent version is retained.

CREATE TABLE IF NOT EXISTS mesh_versions (
    owner_pk_hash TEXT PRIMARY KEY,
    owner_pk      BLOB NOT NULL,    -- raw 32 bytes (Ed25519)
    version       INTEGER NOT NULL, -- monotonic per owner
    blob          BLOB NOT NULL,    -- canonical JSON bytes (what was signed)
    sig           BLOB NOT NULL,    -- 64 bytes Ed25519 signature over `blob`
    updated_at    INTEGER NOT NULL  -- epoch milliseconds
);

CREATE INDEX IF NOT EXISTS idx_mesh_updated ON mesh_versions(updated_at);
