CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 3,
  source TEXT DEFAULT 'unknown',
  pinned INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT DEFAULT NULL,
  vector_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (vector_status IN ('pending', 'ready', 'error')),
  vector_error TEXT DEFAULT NULL,
  vector_updated_at TEXT DEFAULT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT DEFAULT NULL,
  consolidated_from TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_vector_status ON memories(vector_status);

-- D1-backed lexical search complements eventually-consistent Vectorize and
-- guarantees that newly-written memories can be found immediately.
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

-- Originals preserved by nightly consolidation (the AI merge is lossy —
-- never hard-delete the source memories).
CREATE TABLE IF NOT EXISTS memories_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  importance INTEGER,
  source TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER,
  last_accessed_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  consolidated_from TEXT,
  consolidated_into INTEGER,
  restored_memory_id INTEGER DEFAULT NULL,
  restored_at TEXT DEFAULT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_archive_consolidated_into ON memories_archive(consolidated_into);

-- Failed Vectorize deletes are retried by scheduled maintenance. Ghost
-- vectors are harmless for recall (D1 remains authoritative), but cleaning
-- them prevents wasted index capacity and misleading dedup matches.
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
