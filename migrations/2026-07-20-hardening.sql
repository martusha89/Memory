-- Upgrade a v2.2.0 database to the v2.3 hardening schema.
-- Run once with:
--   npx wrangler d1 execute memory-db --remote \
--     --file=migrations/2026-07-20-hardening.sql

ALTER TABLE memories ADD COLUMN content_hash TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN vector_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (vector_status IN ('pending', 'ready', 'error'));
ALTER TABLE memories ADD COLUMN vector_error TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN vector_updated_at TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN vector_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN restored_from_archive_id INTEGER DEFAULT NULL;
ALTER TABLE memories ADD COLUMN maintenance_owner TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN maintenance_expires_at TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_vector_status ON memories(vector_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_restored_from_archive
  ON memories(restored_from_archive_id)
  WHERE restored_from_archive_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_maintenance_expiry
  ON memories(maintenance_expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');

ALTER TABLE memories_archive ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories_archive ADD COLUMN updated_at TEXT DEFAULT NULL;
ALTER TABLE memories_archive ADD COLUMN consolidated_from TEXT DEFAULT NULL;
ALTER TABLE memories_archive ADD COLUMN restored_memory_id INTEGER DEFAULT NULL;
ALTER TABLE memories_archive ADD COLUMN restored_at TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS vector_tombstones (
  memory_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ids TEXT NOT NULL,
  category TEXT NOT NULL,
  result_memory_id INTEGER DEFAULT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  error TEXT DEFAULT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT DEFAULT NULL
);

-- Existing rows intentionally remain pending. Lexical recall remains available
-- while repair_index verifies and refreshes semantic vectors in bounded batches
-- (including metadata used by category-filtered recall).
