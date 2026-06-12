CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 3,
  source TEXT DEFAULT 'unknown',
  pinned INTEGER NOT NULL DEFAULT 0,
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
  access_count INTEGER,
  last_accessed_at TEXT,
  created_at TEXT,
  consolidated_into INTEGER,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_archive_consolidated_into ON memories_archive(consolidated_into);
