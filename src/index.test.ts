import { describe, expect, it } from "vitest";
import {
  createMemorySchema,
  ftsQuery,
  getCategories,
  hashContent,
  likePattern,
  recallSchema,
  safeNumberArray,
  safeStringArray,
  updateMemorySchema,
} from "./core";
import worker from "./index";

describe("REST validation", () => {
  it("accepts a bounded, well-formed memory", () => {
    const result = createMemorySchema.safeParse({
      content: "Marta prefers dark mode",
      category: "preference",
      tags: ["ui"],
      importance: 4,
      source: "web",
    });
    expect(result.success).toBe(true);
  });

  it("rejects source injection and malformed tags", () => {
    expect(
      createMemorySchema.safeParse({
        content: "safe",
        source: '<img src=x onerror="alert(1)">',
        tags: "not-an-array",
      }).success
    ).toBe(false);
  });

  it("rejects empty updates and unsafe recall limits", () => {
    expect(updateMemorySchema.safeParse({}).success).toBe(false);
    expect(recallSchema.safeParse({ query: "memory", limit: -1 }).success).toBe(
      false
    );
  });
});

describe("safe stored JSON parsing", () => {
  it("returns only strings from tag JSON", () => {
    expect(safeStringArray('["one",2,"two",null]')).toEqual(["one", "two"]);
    expect(safeStringArray("broken")).toEqual([]);
  });

  it("returns only integer lineage IDs", () => {
    expect(safeNumberArray('[1,"2",3.5,4]')).toEqual([1, 4]);
    expect(safeNumberArray(null)).toEqual([]);
  });
});

describe("hybrid retrieval helpers", () => {
  it("builds a bounded FTS query from natural language", () => {
    expect(ftsQuery("dark-mode preference! 🖤")).toBe(
      '"dark-mode" OR "preference"'
    );
    expect(ftsQuery("!!!")).toBeNull();
  });

  it("normalizes semantically identical exact-memory hashes", async () => {
    await expect(hashContent("  Likes   tea ")).resolves.toBe(
      await hashContent("likes tea")
    );
  });

  it("bounds LIKE fallbacks to D1's 50-byte pattern limit", () => {
    const pattern = likePattern("%".repeat(2_000));
    expect(pattern).not.toBeNull();
    expect(new TextEncoder().encode(pattern!).length).toBeLessThanOrEqual(50);
    expect(pattern).toMatch(/^%(\\%)+%$/);
  });
});

describe("configuration and browser security", () => {
  it("drops unsafe category names and duplicates", () => {
    const categories = getCategories({
      MEMORY_CATEGORIES: "project,project,bad category,<script>,health",
    } as never);
    expect(categories).toEqual(["project", "health"]);
  });

});

function faultInjectableStoreEnv(options: {
  aiFails?: boolean;
  queryFails?: boolean;
  queryMatch?: boolean;
  upsertFails?: boolean;
  claimFails?: boolean;
}) {
  const statements: string[] = [];
  let upsertCalls = 0;
  const row = {
    id: 1,
    content: "Durable during an outage",
    category: "general",
    tags: "[]",
    importance: 3,
    source: "api",
    pinned: 0,
    content_hash: "hash",
    vector_status: "error",
    vector_error: "injected outage",
    vector_updated_at: null,
    vector_generation: 0,
    access_count: 0,
    last_accessed_at: null,
    consolidated_from: null,
    restored_from_archive_id: null,
    maintenance_owner: null,
    maintenance_expires_at: null,
    created_at: "2026-07-20 00:00:00",
    updated_at: "2026-07-20 00:00:00",
  };

  const DB = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("content_hash = ?")) return null;
          if (sql.includes("INSERT INTO memories")) return row;
          if (sql.includes("SELECT * FROM memories WHERE id = ?")) return row;
          if (sql.includes("SET maintenance_owner = ?") && sql.includes("vector_generation = ?")) {
            return options.claimFails ? null : { id: row.id };
          }
          return null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  };

  return {
    env: {
      MEMORY_SECRET: "secret",
      DB,
      AI: {
        async run() {
          if (options.aiFails) throw new Error("AI unavailable");
          return { data: [[0, 1, 0]] };
        },
      },
      VECTORIZE: {
        async query() {
          if (options.queryFails) throw new Error("Vectorize query unavailable");
          return {
            matches: options.queryMatch
              ? [{ id: "1", score: 0.99, metadata: { category: "general" } }]
              : [],
          };
        },
        async upsert() {
          upsertCalls++;
          if (options.upsertFails) throw new Error("Vectorize write unavailable");
        },
      },
    },
    statements,
    get upsertCalls() {
      return upsertCalls;
    },
  };
}

describe("Worker security boundaries", () => {
  const context = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  it("serves the UI with a per-response CSP nonce", async () => {
    const response = await worker.fetch(
      new Request("https://memory.example/"),
      {} as never,
      context
    );
    const html = await response.text();
    const csp = response.headers.get("Content-Security-Policy") || "";
    expect(response.status).toBe(200);
    expect(csp).toMatch(/script-src 'nonce-[a-f0-9]+'/);
    expect(html).not.toContain("__CSP_NONCE__");
    expect(html).not.toMatch(/\son(?:click|keydown)=/i);
  });

  it("fails closed and rejects query secrets by default", async () => {
    const missing = await worker.fetch(
      new Request("https://memory.example/api/memories"),
      {} as never,
      context
    );
    expect(missing.status).toBe(503);

    const queryOnly = await worker.fetch(
      new Request("https://memory.example/mcp?secret=test"),
      { MEMORY_SECRET: "test" } as never,
      context
    );
    expect(queryOnly.status).toBe(401);
  });

  it("allows only explicitly configured cross-origin clients", async () => {
    const blocked = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      { MEMORY_SECRET: "test" } as never,
      context
    );
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const allowed = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example",
          "Access-Control-Request-Headers":
            "authorization,mcp-protocol-version,mcp-session-id",
        },
      }),
      {
        MEMORY_SECRET: "test",
        MEMORY_ALLOWED_ORIGINS: "https://app.example",
      } as never,
      context
    );
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example"
    );
    expect(allowed.headers.get("Access-Control-Allow-Headers")).toContain(
      "MCP-Protocol-Version"
    );
    expect(allowed.headers.get("Access-Control-Expose-Headers")).toBe(
      "Mcp-Session-Id"
    );
  });

  it("serves Streamable HTTP only on the documented MCP endpoint", async () => {
    const initialize = await worker.fetch(
      new Request("https://memory.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      }),
      { MEMORY_SECRET: "secret" } as never,
      context
    );
    expect(initialize.status).toBe(200);

    const legacySse = await worker.fetch(
      new Request("https://memory.example/sse", {
        headers: { Authorization: "Bearer secret" },
      }),
      { MEMORY_SECRET: "secret" } as never,
      context
    );
    expect(legacySse.status).toBe(404);
  });

  it("rejects malformed writes before touching storage", async () => {
    const response = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "safe",
          source: '<img src=x onerror="alert(1)">',
          tags: "broken",
        }),
      }),
      { MEMORY_SECRET: "secret" } as never,
      context
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("rejects oversized JSON even without trusting Content-Length", async () => {
    const response = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "x".repeat(64_001) }),
      }),
      { MEMORY_SECRET: "secret" } as never,
      context
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Request body is too large",
    });
  });

  it.each([
    ["Workers AI", { aiFails: true }],
    ["Vectorize", { queryFails: true, upsertFails: true }],
  ])("keeps the authoritative D1 write when %s is unavailable", async (_name, faults) => {
    const { env, statements } = faultInjectableStoreEnv(faults);
    const response = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Durable during an outage" }),
      }),
      env as never,
      context
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      indexing_pending: true,
    });
    expect(statements.some((sql) => sql.includes("INSERT INTO memories"))).toBe(true);
  });

  it("rechecks semantic dedup candidates against authoritative D1 state", async () => {
    const { env, statements } = faultInjectableStoreEnv({ queryMatch: true });
    const response = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Durable during an outage" }),
      }),
      env as never,
      context
    );
    expect(response.status).toBe(201);
    expect(
      statements.some(
        (sql) =>
          sql.includes("vector_status = 'ready'") && sql.includes("category = ?")
      )
    ).toBe(true);
  });

  it("does not write a stale vector when the generation lease cannot be claimed", async () => {
    const harness = faultInjectableStoreEnv({ claimFails: true });
    const response = await worker.fetch(
      new Request("https://memory.example/api/memories", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Durable during an outage" }),
      }),
      harness.env as never,
      context
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ indexing_pending: true });
    expect(harness.upsertCalls).toBe(0);
  });

  it("filters recall candidates by D1 vector state and category", async () => {
    const statements: string[] = [];
    const DB = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        };
        return statement;
      },
    };
    const response = await worker.fetch(
      new Request("https://memory.example/api/recall", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "old category", category: "general" }),
      }),
      {
        MEMORY_SECRET: "secret",
        DB,
        AI: { async run() { return { data: [[0, 1, 0]] }; } },
        VECTORIZE: {
          async query() { return { matches: [{ id: "1", score: 0.99 }] }; },
        },
      } as never,
      context
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(
      statements.some(
        (sql) =>
          sql.includes("WHERE id IN") &&
          sql.includes("vector_status = 'ready'") &&
          sql.includes("category = ?")
      )
    ).toBe(true);
  });

  it("rejects an edit while consolidation owns the source row", async () => {
    const existing = {
      id: 7,
      content: "Original",
      category: "general",
      tags: "[]",
      importance: 3,
      source: "api",
      pinned: 0,
      content_hash: "old",
      vector_status: "ready",
      vector_error: null,
      vector_updated_at: null,
      vector_generation: 0,
      access_count: 0,
      last_accessed_at: null,
      consolidated_from: null,
      restored_from_archive_id: null,
      maintenance_owner: "consolidation-job",
      maintenance_expires_at: "2099-01-01 00:00:00",
      created_at: "2026-07-20 00:00:00",
      updated_at: "2026-07-20 00:00:00",
    };
    const DB = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() { return sql.includes("SELECT * FROM memories") ? existing : null; },
          async run() { return { meta: { changes: 0 } }; },
        };
        return statement;
      },
    };
    const response = await worker.fetch(
      new Request("https://memory.example/api/memories/7", {
        method: "PUT",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Concurrent edit" }),
      }),
      { MEMORY_SECRET: "secret", DB } as never,
      context
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("locked"),
    });
  });
});
