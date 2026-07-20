CREATE TABLE memories (
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

CREATE TABLE memories_archive (
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

INSERT INTO memories
  (content, category, tags, importance, source)
VALUES
  ('Marta prefers dark mode', 'preference', '["ui"]', 4, 'api');
