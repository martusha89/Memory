-- Migration for databases created before v2.2.0.
-- Fresh installs get all of this from schema.sql — do NOT run this there
-- (the ALTER will fail on a duplicate column, which is fine/expected).
--
-- Run with:
--   npx wrangler d1 execute memory-db --remote --file migrations/2026-06-12-pinned-and-archive.sql

ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

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
