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
  wrangler([...common, "--file=test/fixtures/schema-v2.2.sql"]);
  wrangler([...common, "--file=migrations/2026-07-20-hardening.sql"]);
  const result = wrangler([
    ...common,
    "--command=SELECT m.content, m.vector_status FROM memories_fts f JOIN memories m ON m.id=f.rowid WHERE memories_fts MATCH 'dark';",
  ]);
  if (!result.includes("Marta prefers dark mode") || !result.includes("ready")) {
    throw new Error("Migrated FTS data or vector status was not preserved");
  }
  console.log("v2.2 -> v2.3 migration verified");
} finally {
  rmSync(persistTo, { recursive: true, force: true });
}
