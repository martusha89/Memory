-- v3 safety foundation. Apply once to a v2.2 database.
-- Back up D1 before migration, then run:
-- npx wrangler d1 execute memory-db --remote --file migrations/2026-08-21-v3-safety-foundation.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN dedupe_key TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN indexed_version INTEGER DEFAULT NULL;
ALTER TABLE memories ADD COLUMN index_status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash
  ON memories(content_hash) WHERE status = 'active' AND content_hash <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe_key_active
  ON memories(dedupe_key) WHERE status = 'active' AND dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  record_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL,
  importance INTEGER NOT NULL,
  source TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(memory_id, record_version)
);

CREATE INDEX IF NOT EXISTS idx_memory_versions_memory
  ON memory_versions(memory_id, record_version DESC);

CREATE TABLE IF NOT EXISTS index_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  record_version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT NULL,
  next_attempt_at TEXT DEFAULT NULL,
  locked_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT DEFAULT NULL,
  UNIQUE(memory_id, record_version, operation)
);

CREATE INDEX IF NOT EXISTS idx_index_outbox_pending
  ON index_outbox(state, next_attempt_at, created_at);

-- Snapshot all existing rows before triggers begin recording new versions.
INSERT OR IGNORE INTO memory_versions
  (memory_id, record_version, content, category, tags, importance, source, pinned, status, content_hash, change_kind)
SELECT id, record_version, content, category, tags, importance, source, pinned, status, content_hash, 'migration'
FROM memories;

INSERT OR IGNORE INTO index_outbox
  (memory_id, record_version, operation, content_hash)
SELECT id, record_version, 'upsert', content_hash FROM memories;

CREATE TRIGGER IF NOT EXISTS memories_version_after_insert
AFTER INSERT ON memories
BEGIN
  INSERT OR IGNORE INTO memory_versions
    (memory_id, record_version, content, category, tags, importance, source, pinned, status, content_hash, change_kind)
  VALUES
    (NEW.id, NEW.record_version, NEW.content, NEW.category, NEW.tags, NEW.importance, NEW.source, NEW.pinned, NEW.status, NEW.content_hash, 'create');
  INSERT OR IGNORE INTO index_outbox
    (memory_id, record_version, operation, content_hash)
  VALUES (NEW.id, NEW.record_version, 'upsert', NEW.content_hash);
END;

CREATE TRIGGER IF NOT EXISTS memories_version_after_update
AFTER UPDATE OF content, category, tags, importance, pinned, status, record_version ON memories
WHEN NEW.record_version <> OLD.record_version
BEGIN
  INSERT OR IGNORE INTO memory_versions
    (memory_id, record_version, content, category, tags, importance, source, pinned, status, content_hash, change_kind)
  VALUES
    (NEW.id, NEW.record_version, NEW.content, NEW.category, NEW.tags, NEW.importance, NEW.source, NEW.pinned, NEW.status, NEW.content_hash, 'update');
  INSERT OR IGNORE INTO index_outbox
    (memory_id, record_version, operation, content_hash)
  VALUES (NEW.id, NEW.record_version, 'upsert', NEW.content_hash);
END;

CREATE TRIGGER IF NOT EXISTS memories_index_after_delete
AFTER DELETE ON memories
BEGIN
  INSERT OR IGNORE INTO index_outbox
    (memory_id, record_version, operation, content_hash)
  VALUES (OLD.id, OLD.record_version + 1, 'delete', OLD.content_hash);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memories',
  content_rowid='id'
);
INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS memories_fts_after_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_after_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_after_update AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
  INSERT INTO memory_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;

INSERT OR IGNORE INTO schema_migrations(version)
VALUES ('2026-08-21-v3-safety-foundation');
