import { describe, expect, it } from "vitest";
import {
  createMemorySchema,
  ftsQuery,
  getCategories,
  hashContent,
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
});

describe("configuration and browser security", () => {
  it("drops unsafe category names and duplicates", () => {
    const categories = getCategories({
      MEMORY_CATEGORIES: "project,project,bad category,<script>,health",
    } as never);
    expect(categories).toEqual(["project", "health"]);
  });

});

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
        headers: { Origin: "https://app.example" },
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
});
