import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const persistTo = mkdtempSync(join(tmpdir(), "memory-migration-"));
const wranglerCli = resolve("node_modules/wrangler/bin/wrangler.js");

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerCli, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  const common = [
    "d1",
    "execute",
    "memory-db",
    "--local",
    "--persist-to",
    persistTo,
  ];
  wrangler([...common, "--file=test/fixtures/schema-v2.1.sql"]);
  wrangler([...common, "--file=migrations/2026-06-12-pinned-and-archive.sql"]);
  wrangler([...common, "--file=migrations/2026-07-20-hardening.sql"]);
  const result = wrangler([
    ...common,
    "--command=SELECT m.content, m.vector_status FROM memories_fts f JOIN memories m ON m.id=f.rowid WHERE memories_fts MATCH 'dark';",
  ]);
  if (!result.includes("Marta prefers dark mode") || !result.includes("pending")) {
    throw new Error("Migrated FTS data or vector status was not preserved");
  }

  wrangler([
    ...common,
    "--command=UPDATE memories SET maintenance_owner='job', maintenance_expires_at=datetime('now', '+15 minutes') WHERE id=1;",
  ]);
  wrangler([
    ...common,
    "--command=UPDATE memories SET content='raced edit' WHERE id=1 AND (maintenance_owner IS NULL OR maintenance_expires_at < datetime('now'));",
  ]);
  const locked = wrangler([
    ...common,
    "--command=SELECT content, maintenance_owner FROM memories WHERE id=1;",
  ]);
  if (locked.includes("raced edit") || !locked.includes("job")) {
    throw new Error("Maintenance reservation did not protect the source row");
  }

  wrangler([
    ...common,
    "--command=UPDATE memories SET maintenance_owner=NULL, maintenance_expires_at=NULL, vector_generation=vector_generation+1 WHERE id=1;",
  ]);
  wrangler([
    ...common,
    "--command=UPDATE memories SET maintenance_owner='stale-index' WHERE id=1 AND vector_generation=0 AND maintenance_owner IS NULL;",
  ]);
  const staleGeneration = wrangler([
    ...common,
    "--command=SELECT vector_generation, maintenance_owner FROM memories WHERE id=1;",
  ]);
  if (staleGeneration.includes("stale-index")) {
    throw new Error("A stale vector generation acquired the indexing lease");
  }
  wrangler([
    ...common,
    "--command=UPDATE memories SET maintenance_owner='fresh-index' WHERE id=1 AND vector_generation=1 AND maintenance_owner IS NULL;",
  ]);
  const freshGeneration = wrangler([
    ...common,
    "--command=SELECT vector_generation, maintenance_owner FROM memories WHERE id=1;",
  ]);
  if (!freshGeneration.includes("fresh-index")) {
    throw new Error("The current vector generation could not acquire the indexing lease");
  }

  wrangler([
    ...common,
    "--command=UPDATE memories SET maintenance_owner=NULL, maintenance_expires_at=NULL, content='first update', content_hash='first-hash', vector_generation=2 WHERE id=1 AND content IS 'Marta prefers dark mode' AND category IS 'preference' AND tags IS '[\"ui\"]' AND importance IS 4 AND content_hash IS NULL AND vector_generation=1;",
  ]);
  wrangler([
    ...common,
    "--command=UPDATE memories SET content='Marta prefers dark mode', tags='[\"concurrent\"]' WHERE id=1 AND content IS 'Marta prefers dark mode' AND category IS 'preference' AND tags IS '[\"ui\"]' AND importance IS 4 AND content_hash IS NULL AND vector_generation=1;",
  ]);
  const concurrentUpdate = wrangler([
    ...common,
    "--command=SELECT content, tags, vector_generation FROM memories WHERE id=1;",
  ]);
  if (!concurrentUpdate.includes("first update") || concurrentUpdate.includes("concurrent")) {
    throw new Error("A stale partial update overwrote a concurrent content change");
  }

  wrangler([
    ...common,
    "--command=INSERT INTO memories(content, restored_from_archive_id) VALUES ('first restore', 99);",
  ]);
  let duplicateRestoreRejected = false;
  try {
    wrangler([
      ...common,
      "--command=INSERT INTO memories(content, restored_from_archive_id) VALUES ('second restore', 99);",
    ]);
  } catch {
    duplicateRestoreRejected = true;
  }
  if (!duplicateRestoreRejected) {
    throw new Error("Archive restore uniqueness constraint was not enforced");
  }
  console.log("v2.1 -> v2.2 -> v2.3 migration chain verified");
} finally {
  rmSync(persistTo, { recursive: true, force: true });
}
