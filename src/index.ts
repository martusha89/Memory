import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────
interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MEMORY_SECRET: string;
  MEMORY_CATEGORIES?: string;
  MEMORY_BEHAVIOR?: string;
}

interface Memory {
  id: number;
  content: string;
  category: string;
  tags: string;
  importance: number;
  source: string;
  access_count: number;
  last_accessed_at: string | null;
  consolidated_from: string | null;
  created_at: string;
  updated_at: string;
}

// ── Constants ─────────────────────────────────────────────────────────
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const CONSOLIDATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const SIMILARITY_THRESHOLD = 0.85;
const STALE_DAYS = 90;
const MAX_CONSOLIDATION_BATCHES = 20;

const DEFAULT_CATEGORIES = [
  "people",
  "preference",
  "fact",
  "project",
  "health",
  "date",
  "technical",
  "reflection",
  "general",
] as const;

const SOURCES = [
  "claude_code",
  "claude_desktop",
  "claude_web",
  "claude_mobile",
  "api",
  "unknown",
] as const;

type BehaviorMode = "proactive" | "balanced" | "manual";

// ── Helpers ───────────────────────────────────────────────────────────
function getCategories(env: Env): string[] {
  if (env.MEMORY_CATEGORIES) {
    return env.MEMORY_CATEGORIES.split(",").map((c) => c.trim().toLowerCase());
  }
  return [...DEFAULT_CATEGORIES];
}

function getBehavior(env: Env): BehaviorMode {
  const mode = env.MEMORY_BEHAVIOR?.toLowerCase();
  if (mode === "balanced" || mode === "manual") return mode;
  return "proactive";
}

async function embed(ai: Ai, text: string): Promise<number[]> {
  const resp = await ai.run(EMBEDDING_MODEL, { text: [text] });
  return (resp as any).data[0];
}

function formatMemory(m: Memory) {
  return {
    id: m.id,
    content: m.content,
    category: m.category,
    tags: JSON.parse(m.tags || "[]"),
    importance: m.importance,
    source: m.source,
    access_count: m.access_count,
    last_accessed_at: m.last_accessed_at,
    created_at: m.created_at,
    updated_at: m.updated_at,
    consolidated_from: m.consolidated_from
      ? JSON.parse(m.consolidated_from)
      : null,
  };
}

// ── CORS & Response Helpers ──────────────────────────────────────────
function cors(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResp(data: any, request: Request, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

function apiError(msg: string, request: Request, status = 400): Response {
  return jsonResp({ error: msg }, request, status);
}

// ── REST API Handler ─────────────────────────────────────────────────
async function handleApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;
  const categories = getCategories(env);

  // GET /api/categories
  if (path === "/api/categories" && method === "GET") {
    return jsonResp({ categories, behavior: getBehavior(env) }, request);
  }

  // GET /api/stats
  if (path === "/api/stats" && method === "GET") {
    const total = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM memories"
    ).first<{ count: number }>();
    const byCategory = await env.DB.prepare(
      "SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC"
    ).all();
    const bySource = await env.DB.prepare(
      "SELECT source, COUNT(*) as count FROM memories GROUP BY source ORDER BY count DESC"
    ).all();
    const byImportance = await env.DB.prepare(
      "SELECT importance, COUNT(*) as count FROM memories GROUP BY importance ORDER BY importance DESC"
    ).all();
    const staleCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE (last_accessed_at IS NOT NULL AND last_accessed_at < datetime('now', '-90 days'))
          OR (last_accessed_at IS NULL AND created_at < datetime('now', '-90 days'))`
    ).first<{ count: number }>();
    const oldest = await env.DB.prepare(
      "SELECT created_at FROM memories ORDER BY created_at ASC LIMIT 1"
    ).first<{ created_at: string }>();
    const newest = await env.DB.prepare(
      "SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1"
    ).first<{ created_at: string }>();
    const mostAccessed = await env.DB.prepare(
      "SELECT id, content, access_count FROM memories ORDER BY access_count DESC LIMIT 3"
    ).all();

    return jsonResp(
      {
        total_memories: total?.count || 0,
        by_category: byCategory.results,
        by_source: bySource.results,
        by_importance: byImportance.results,
        stale_memories: staleCount?.count || 0,
        oldest_memory: oldest?.created_at || null,
        newest_memory: newest?.created_at || null,
        most_accessed: mostAccessed.results,
        behavior_mode: getBehavior(env),
        categories_configured: categories,
      },
      request
    );
  }

  // GET /api/stale?days=90&limit=20
  if (path === "/api/stale" && method === "GET") {
    const days = parseInt(url.searchParams.get("days") || "90");
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "20"),
      50
    );
    const { results } = await env.DB.prepare(
      `SELECT * FROM memories
       WHERE (last_accessed_at IS NOT NULL AND last_accessed_at < datetime('now', ?))
          OR (last_accessed_at IS NULL AND created_at < datetime('now', ?))
       ORDER BY importance ASC, created_at ASC LIMIT ?`
    )
      .bind(`-${days} days`, `-${days} days`, limit)
      .all();
    return jsonResp((results as Memory[]).map(formatMemory), request);
  }

  // POST /api/recall
  if (path === "/api/recall" && method === "POST") {
    const body = (await request.json()) as any;
    const { query, category, limit: rawLimit } = body;
    if (!query) return apiError("query is required", request);
    const limit = Math.min(rawLimit || 10, 20);

    if (category && !categories.includes(category)) {
      return apiError(
        `Invalid category "${category}". Available: ${categories.join(", ")}`,
        request
      );
    }

    const queryVector = await embed(env.AI, query);
    const queryOptions: VectorizeQueryOptions = {
      topK: limit,
      returnMetadata: "all",
    };
    if (category) queryOptions.filter = { category };

    const vectorResults = await env.VECTORIZE.query(queryVector, queryOptions);

    if (!vectorResults.matches || vectorResults.matches.length === 0) {
      // Fallback: keyword search
      let fallbackQuery = "SELECT * FROM memories WHERE content LIKE ?";
      const fallbackBinds: any[] = [`%${query}%`];
      if (category) {
        fallbackQuery += " AND category = ?";
        fallbackBinds.push(category);
      }
      fallbackQuery +=
        " ORDER BY importance DESC, created_at DESC LIMIT ?";
      fallbackBinds.push(limit);
      const { results } = await env.DB.prepare(fallbackQuery)
        .bind(...fallbackBinds)
        .all();

      if (results && results.length > 0) {
        const ids = (results as Memory[]).map((m) => m.id);
        const ph = ids.map(() => "?").join(",");
        await env.DB.prepare(
          `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id IN (${ph})`
        )
          .bind(...ids)
          .run();
        return jsonResp(
          (results as Memory[]).map((m) => ({
            ...formatMemory(m),
            score: null,
            match_type: "keyword",
          })),
          request
        );
      }
      return jsonResp([], request);
    }

    // Fetch full records from D1
    const ids = vectorResults.matches.map((m) => m.id);
    const ph = ids.map(() => "?").join(",");
    const { results: memories } = await env.DB.prepare(
      `SELECT * FROM memories WHERE id IN (${ph})`
    )
      .bind(...ids)
      .all();

    if (memories && memories.length > 0) {
      const memIds = (memories as Memory[]).map((m) => m.id);
      const mph = memIds.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id IN (${mph})`
      )
        .bind(...memIds)
        .run();
    }

    const enriched = vectorResults.matches
      .map((match) => {
        const memory = (memories as Memory[])?.find(
          (m) => m.id.toString() === match.id
        );
        if (!memory) return null;
        const importanceBoost = memory.importance / 5;
        const weightedScore = match.score * 0.7 + importanceBoost * 0.3;
        return {
          ...formatMemory(memory),
          score: Math.round(match.score * 100) / 100,
          weighted_score: Math.round(weightedScore * 100) / 100,
          match_type: "semantic",
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.weighted_score - a.weighted_score);

    return jsonResp(enriched, request);
  }

  // ── Memory CRUD: /api/memories ────────────────────────────────────
  const memoryMatch = path.match(/^\/api\/memories(?:\/(\d+))?$/);
  if (memoryMatch) {
    const id = memoryMatch[1] ? parseInt(memoryMatch[1]) : null;

    // GET /api/memories — list with pagination
    if (method === "GET" && !id) {
      const category = url.searchParams.get("category");
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "50"),
        100
      );
      const offset = parseInt(url.searchParams.get("offset") || "0");
      const sort = url.searchParams.get("sort") || "created_at";
      const order =
        url.searchParams.get("order") === "asc" ? "ASC" : "DESC";

      let query = "SELECT * FROM memories";
      const binds: any[] = [];
      if (category) {
        if (!categories.includes(category))
          return apiError("Invalid category", request);
        query += " WHERE category = ?";
        binds.push(category);
      }

      const validSorts = [
        "created_at",
        "updated_at",
        "importance",
        "access_count",
      ];
      const sortCol = validSorts.includes(sort) ? sort : "created_at";
      query += ` ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`;
      binds.push(limit, offset);

      const { results } = await env.DB.prepare(query)
        .bind(...binds)
        .all();

      let countQuery = "SELECT COUNT(*) as count FROM memories";
      const countBinds: any[] = [];
      if (category) {
        countQuery += " WHERE category = ?";
        countBinds.push(category);
      }
      const total = await env.DB.prepare(countQuery)
        .bind(...countBinds)
        .first<{ count: number }>();

      return jsonResp(
        {
          memories: (results as Memory[]).map(formatMemory),
          total: total?.count || 0,
          limit,
          offset,
        },
        request
      );
    }

    // GET /api/memories/:id
    if (method === "GET" && id) {
      const memory = await env.DB.prepare(
        "SELECT * FROM memories WHERE id = ?"
      )
        .bind(id)
        .first<Memory>();
      if (!memory) return apiError("Memory not found", request, 404);
      return jsonResp(formatMemory(memory), request);
    }

    // POST /api/memories — store
    if (method === "POST" && !id) {
      const body = (await request.json()) as any;
      const {
        content,
        category = "general",
        tags = [],
        importance = 3,
        source = "api",
        force = false,
      } = body;
      if (!content) return apiError("content is required", request);
      if (!categories.includes(category))
        return apiError(
          `Invalid category "${category}". Available: ${categories.join(", ")}`,
          request
        );
      if (importance < 1 || importance > 5)
        return apiError("importance must be 1-5", request);

      const vector = await embed(env.AI, content);

      // Dedup check
      if (!force) {
        const similar = await env.VECTORIZE.query(vector, {
          topK: 3,
          returnMetadata: "all",
        });
        if (similar.matches?.length) {
          const dupes = similar.matches.filter(
            (m) => m.score >= SIMILARITY_THRESHOLD
          );
          if (dupes.length > 0) {
            const dupeIds = dupes.map((d) => d.id);
            const dph = dupeIds.map(() => "?").join(",");
            const { results } = await env.DB.prepare(
              `SELECT id, content, category FROM memories WHERE id IN (${dph})`
            )
              .bind(...dupeIds)
              .all();
            const existing = (results as Memory[])[0];
            if (existing) {
              return jsonResp(
                {
                  duplicate: true,
                  existing_id: existing.id,
                  existing_content: existing.content,
                  similarity: Math.round(dupes[0].score * 100),
                  message:
                    "Similar memory exists. Send force=true to store anyway.",
                },
                request,
                409
              );
            }
          }
        }
      }

      const result = await env.DB.prepare(
        "INSERT INTO memories (content, category, tags, importance, source) VALUES (?, ?, ?, ?, ?) RETURNING *"
      )
        .bind(content, category, JSON.stringify(tags), importance, source)
        .first<Memory>();

      if (!result)
        return apiError("Failed to store memory", request, 500);

      await env.VECTORIZE.upsert([
        {
          id: result.id.toString(),
          values: vector,
          metadata: {
            category,
            source,
            importance,
            timestamp: Date.now(),
          },
        },
      ]);

      return jsonResp(formatMemory(result), request, 201);
    }

    // PUT /api/memories/:id — update
    if (method === "PUT" && id) {
      const body = (await request.json()) as any;
      const { content, category, tags, importance } = body;

      if (category && !categories.includes(category))
        return apiError("Invalid category", request);
      if (importance !== undefined && (importance < 1 || importance > 5))
        return apiError("importance must be 1-5", request);

      const existing = await env.DB.prepare(
        "SELECT * FROM memories WHERE id = ?"
      )
        .bind(id)
        .first<Memory>();
      if (!existing)
        return apiError("Memory not found", request, 404);

      const newContent = content ?? existing.content;
      const newCategory = category ?? existing.category;
      const newTags =
        tags !== undefined ? JSON.stringify(tags) : existing.tags;
      const newImportance = importance ?? existing.importance;

      await env.DB.prepare(
        `UPDATE memories SET content = ?, category = ?, tags = ?, importance = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(newContent, newCategory, newTags, newImportance, id)
        .run();

      if (content) {
        const vector = await embed(env.AI, newContent);
        await env.VECTORIZE.upsert([
          {
            id: id.toString(),
            values: vector,
            metadata: {
              category: newCategory,
              source: existing.source,
              importance: newImportance,
              timestamp: Date.now(),
            },
          },
        ]);
      }

      const updated = await env.DB.prepare(
        "SELECT * FROM memories WHERE id = ?"
      )
        .bind(id)
        .first<Memory>();
      return jsonResp(formatMemory(updated!), request);
    }

    // DELETE /api/memories/:id — forget
    if (method === "DELETE" && id) {
      const existing = await env.DB.prepare(
        "SELECT id FROM memories WHERE id = ?"
      )
        .bind(id)
        .first();
      if (!existing)
        return apiError("Memory not found", request, 404);

      await env.DB.prepare("DELETE FROM memories WHERE id = ?")
        .bind(id)
        .run();
      await env.VECTORIZE.deleteByIds([id.toString()]);

      return jsonResp({ deleted: true, id }, request);
    }
  }

  // GET /api/tags/:tag
  const tagMatch = path.match(/^\/api\/tags\/(.+)$/);
  if (tagMatch && method === "GET") {
    const tag = decodeURIComponent(tagMatch[1]);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "20"),
      50
    );
    const { results } = await env.DB.prepare(
      `SELECT * FROM memories WHERE tags LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?`
    )
      .bind(`%"${tag}"%`, limit)
      .all();
    return jsonResp((results as Memory[]).map(formatMemory), request);
  }

  return apiError("Not found", request, 404);
}

// ── Tool Descriptions by Behavior Mode ────────────────────────────────
function descriptions(mode: BehaviorMode) {
  const base = {
    store_memory: {
      proactive:
        "Proactively store important information whenever you learn something new about the user — preferences, facts, decisions, people, health details, project context. Do NOT wait to be asked. If it's worth remembering, store it immediately. Duplicates are caught automatically.",
      balanced:
        "Store key facts, preferences, and decisions when they come up in conversation. Focus on information that would be useful in future sessions.",
      manual:
        "Store a memory. Only use this when the user explicitly asks you to remember something.",
    },
    recall: {
      proactive:
        "Search memories by meaning. Call this at the START of every conversation to check for relevant context. Also call it whenever the user asks something that might relate to past conversations. Use natural language queries.",
      balanced:
        "Search memories by meaning when the current topic might benefit from past context. Use natural language queries like 'what does the user prefer for X'.",
      manual:
        "Search memories by meaning. Use when the user asks you to recall or look up something they previously stored.",
    },
    update_memory:
      "Update an existing memory's content, category, tags, or importance. Use this when you learn new details about something already stored — don't create duplicates, update the existing memory instead. The memory is re-embedded automatically.",
    review_stale:
      "List memories that haven't been accessed in a while. Use this to help the user clean up old, potentially outdated memories. Returns memories not recalled in the specified number of days.",
    memory_stats:
      "Get statistics about the memory store — total count, breakdown by category and source, importance distribution, stale memory count, and storage health.",
  };

  return {
    store: base.store_memory[mode],
    recall: base.recall[mode],
    update: base.update_memory,
    review_stale: base.review_stale,
    stats: base.memory_stats,
  };
}

// ── MCP Server ────────────────────────────────────────────────────────
function createServer(env: Env) {
  const server = new McpServer({
    name: "Memory",
    version: "2.0.0",
  });

  const categories = getCategories(env);
  const mode = getBehavior(env);
  const desc = descriptions(mode);

  // ── store_memory ──────────────────────────────────────────────────
  server.tool("store_memory", desc.store, {
    content: z.string().describe("The memory content to store"),
    category: z
      .string()
      .default("general")
      .describe(`Category: ${categories.join(", ")}`),
    tags: z
      .array(z.string())
      .default([])
      .describe("Optional tags for filtering"),
    importance: z
      .number()
      .min(1)
      .max(5)
      .default(3)
      .describe(
        "Importance 1-5 (1=trivial, 3=normal, 5=critical — e.g. allergies, key decisions)"
      ),
    source: z
      .enum(SOURCES)
      .default("unknown")
      .describe("Which client stored this memory"),
    force: z
      .boolean()
      .default(false)
      .describe("Skip duplicate check and store anyway"),
  }, async ({ content, category, tags, importance, source, force }) => {
    // Validate category
    if (!categories.includes(category)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid category "${category}". Available: ${categories.join(", ")}`,
          },
        ],
      };
    }

    // Generate embedding
    const vector = await embed(env.AI, content);

    // Dedup check
    if (!force) {
      const similar = await env.VECTORIZE.query(vector, {
        topK: 3,
        returnMetadata: "all",
      });

      if (similar.matches && similar.matches.length > 0) {
        const dupes = similar.matches.filter(
          (m) => m.score >= SIMILARITY_THRESHOLD
        );
        if (dupes.length > 0) {
          const ids = dupes.map((d) => d.id);
          const placeholders = ids.map(() => "?").join(",");
          const { results } = await env.DB.prepare(
            `SELECT id, content, category FROM memories WHERE id IN (${placeholders})`
          )
            .bind(...ids)
            .all();

          const existing = (results as Memory[])[0];
          if (existing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Similar memory already exists (id: ${existing.id}, similarity: ${Math.round(dupes[0].score * 100)}%):\n"${existing.content}"\n\nUse update_memory to modify it, or call store_memory with force=true to store anyway.`,
                },
              ],
            };
          }
        }
      }
    }

    // Insert into D1
    const result = await env.DB.prepare(
      "INSERT INTO memories (content, category, tags, importance, source) VALUES (?, ?, ?, ?, ?) RETURNING id"
    )
      .bind(content, category, JSON.stringify(tags), importance, source)
      .first<{ id: number }>();

    if (!result) {
      return {
        content: [
          { type: "text" as const, text: "Failed to store memory." },
        ],
      };
    }

    // Upsert vector
    await env.VECTORIZE.upsert([
      {
        id: result.id.toString(),
        values: vector,
        metadata: { category, source, importance, timestamp: Date.now() },
      },
    ]);

    return {
      content: [
        {
          type: "text" as const,
          text: `Memory stored (id: ${result.id}, category: ${category}, importance: ${importance}).`,
        },
      ],
    };
  });

  // ── update_memory ─────────────────────────────────────────────────
  server.tool("update_memory", desc.update, {
    id: z.number().describe("The memory ID to update"),
    content: z
      .string()
      .optional()
      .describe("New content (re-embeds automatically)"),
    category: z
      .string()
      .optional()
      .describe("New category"),
    tags: z
      .array(z.string())
      .optional()
      .describe("New tags (replaces existing)"),
    importance: z
      .number()
      .min(1)
      .max(5)
      .optional()
      .describe("New importance level"),
  }, async ({ id, content, category, tags, importance }) => {
    // Validate category if provided
    if (category && !categories.includes(category)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid category "${category}". Available: ${categories.join(", ")}`,
          },
        ],
      };
    }

    // Fetch existing
    const existing = await env.DB.prepare(
      "SELECT * FROM memories WHERE id = ?"
    )
      .bind(id)
      .first<Memory>();

    if (!existing) {
      return {
        content: [
          { type: "text" as const, text: `Memory ${id} not found.` },
        ],
      };
    }

    // Build update
    const newContent = content ?? existing.content;
    const newCategory = category ?? existing.category;
    const newTags =
      tags !== undefined ? JSON.stringify(tags) : existing.tags;
    const newImportance = importance ?? existing.importance;

    await env.DB.prepare(
      `UPDATE memories SET content = ?, category = ?, tags = ?, importance = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(newContent, newCategory, newTags, newImportance, id)
      .run();

    // Re-embed if content changed
    if (content) {
      const vector = await embed(env.AI, newContent);
      await env.VECTORIZE.upsert([
        {
          id: id.toString(),
          values: vector,
          metadata: {
            category: newCategory,
            source: existing.source,
            importance: newImportance,
            timestamp: Date.now(),
          },
        },
      ]);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Memory ${id} updated.${content ? " (re-embedded)" : ""}`,
        },
      ],
    };
  });

  // ── recall ────────────────────────────────────────────────────────
  server.tool("recall", desc.recall, {
    query: z.string().describe("Natural language search query"),
    category: z
      .string()
      .optional()
      .describe("Optional: filter by category"),
    limit: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Number of results to return"),
  }, async ({ query, category, limit }) => {
    if (category && !categories.includes(category)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid category "${category}". Available: ${categories.join(", ")}`,
          },
        ],
      };
    }

    const queryVector = await embed(env.AI, query);

    const queryOptions: VectorizeQueryOptions = {
      topK: limit,
      returnMetadata: "all",
    };
    if (category) {
      queryOptions.filter = { category };
    }

    const vectorResults = await env.VECTORIZE.query(queryVector, queryOptions);

    if (!vectorResults.matches || vectorResults.matches.length === 0) {
      // Fallback: keyword search
      let fallbackQuery = "SELECT * FROM memories WHERE content LIKE ?";
      const fallbackBinds: any[] = [`%${query}%`];

      if (category) {
        fallbackQuery += " AND category = ?";
        fallbackBinds.push(category);
      }

      fallbackQuery += " ORDER BY importance DESC, created_at DESC LIMIT ?";
      fallbackBinds.push(limit);

      const { results: fallbackResults } = await env.DB.prepare(fallbackQuery)
        .bind(...fallbackBinds)
        .all();

      if (fallbackResults && fallbackResults.length > 0) {
        // Update access tracking
        const ids = (fallbackResults as Memory[]).map((m) => m.id);
        const placeholders = ids.map(() => "?").join(",");
        await env.DB.prepare(
          `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id IN (${placeholders})`
        )
          .bind(...ids)
          .run();

        const formatted = (fallbackResults as Memory[]).map((m) => ({
          ...formatMemory(m),
          score: "keyword_match",
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "No memories found matching that query.",
          },
        ],
      };
    }

    // Fetch full records
    const ids = vectorResults.matches.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const { results: memories } = await env.DB.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    )
      .bind(...ids)
      .all();

    // Update access tracking
    if (memories && memories.length > 0) {
      const memIds = (memories as Memory[]).map((m) => m.id);
      const memPlaceholders = memIds.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id IN (${memPlaceholders})`
      )
        .bind(...memIds)
        .run();
    }

    // Enrich with scores and sort by importance-weighted score
    const enriched = vectorResults.matches
      .map((match) => {
        const memory = (memories as Memory[])?.find(
          (m) => m.id.toString() === match.id
        );
        if (!memory) return null;
        const importanceBoost = memory.importance / 5;
        const weightedScore =
          match.score * 0.7 + importanceBoost * 0.3;
        return {
          ...formatMemory(memory),
          score: Math.round(match.score * 100) / 100,
          weighted_score: Math.round(weightedScore * 100) / 100,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.weighted_score - a.weighted_score);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(enriched, null, 2),
        },
      ],
    };
  });

  // ── list_recent ───────────────────────────────────────────────────
  server.tool(
    "list_recent",
    "List the most recent memories, optionally filtered by category.",
    {
      category: z
        .string()
        .optional()
        .describe("Optional: filter by category"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of memories to return"),
    },
    async ({ category, limit }) => {
      let query = "SELECT * FROM memories";
      const binds: any[] = [];

      if (category) {
        if (!categories.includes(category)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid category "${category}". Available: ${categories.join(", ")}`,
              },
            ],
          };
        }
        query += " WHERE category = ?";
        binds.push(category);
      }

      query += " ORDER BY created_at DESC LIMIT ?";
      binds.push(limit);

      const { results } = await env.DB.prepare(query).bind(...binds).all();
      const formatted = (results as Memory[]).map(formatMemory);

      return {
        content: [
          {
            type: "text" as const,
            text:
              formatted.length > 0
                ? JSON.stringify(formatted, null, 2)
                : "No memories found.",
          },
        ],
      };
    }
  );

  // ── search_by_tag ─────────────────────────────────────────────────
  server.tool(
    "search_by_tag",
    "Search memories by tag.",
    {
      tag: z.string().describe("Tag to search for"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of results"),
    },
    async ({ tag, limit }) => {
      const { results } = await env.DB.prepare(
        `SELECT * FROM memories WHERE tags LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?`
      )
        .bind(`%"${tag}"%`, limit)
        .all();

      const formatted = (results as Memory[]).map(formatMemory);

      return {
        content: [
          {
            type: "text" as const,
            text:
              formatted.length > 0
                ? JSON.stringify(formatted, null, 2)
                : `No memories found with tag "${tag}".`,
          },
        ],
      };
    }
  );

  // ── forget ────────────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete a memory by ID. This is permanent.",
    {
      id: z.number().describe("The memory ID to delete"),
    },
    async ({ id }) => {
      const existing = await env.DB.prepare(
        "SELECT id FROM memories WHERE id = ?"
      )
        .bind(id)
        .first();

      if (!existing) {
        return {
          content: [
            { type: "text" as const, text: `Memory ${id} not found.` },
          ],
        };
      }

      await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
      await env.VECTORIZE.deleteByIds([id.toString()]);

      return {
        content: [
          { type: "text" as const, text: `Memory ${id} forgotten.` },
        ],
      };
    }
  );

  // ── review_stale ──────────────────────────────────────────────────
  server.tool("review_stale", desc.review_stale, {
    days: z
      .number()
      .min(1)
      .default(STALE_DAYS)
      .describe("Number of days without access to consider stale"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(20)
      .describe("Number of stale memories to return"),
  }, async ({ days, limit }) => {
    const { results } = await env.DB.prepare(
      `SELECT * FROM memories
       WHERE (last_accessed_at IS NOT NULL AND last_accessed_at < datetime('now', ?))
          OR (last_accessed_at IS NULL AND created_at < datetime('now', ?))
       ORDER BY importance ASC, created_at ASC
       LIMIT ?`
    )
      .bind(`-${days} days`, `-${days} days`, limit)
      .all();

    const formatted = (results as Memory[]).map(formatMemory);

    return {
      content: [
        {
          type: "text" as const,
          text:
            formatted.length > 0
              ? `Found ${formatted.length} stale memories (not accessed in ${days}+ days):\n\n${JSON.stringify(formatted, null, 2)}\n\nUse forget(id) to remove any that are no longer relevant.`
              : `No stale memories found (all accessed within ${days} days).`,
        },
      ],
    };
  });

  // ── memory_stats ──────────────────────────────────────────────────
  server.tool("memory_stats", desc.stats, {}, async () => {
    const total = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM memories"
    ).first<{ count: number }>();

    const byCategory = await env.DB.prepare(
      "SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC"
    ).all();

    const bySource = await env.DB.prepare(
      "SELECT source, COUNT(*) as count FROM memories GROUP BY source ORDER BY count DESC"
    ).all();

    const byImportance = await env.DB.prepare(
      "SELECT importance, COUNT(*) as count FROM memories GROUP BY importance ORDER BY importance DESC"
    ).all();

    const staleCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE (last_accessed_at IS NOT NULL AND last_accessed_at < datetime('now', '-90 days'))
          OR (last_accessed_at IS NULL AND created_at < datetime('now', '-90 days'))`
    ).first<{ count: number }>();

    const oldest = await env.DB.prepare(
      "SELECT created_at FROM memories ORDER BY created_at ASC LIMIT 1"
    ).first<{ created_at: string }>();

    const newest = await env.DB.prepare(
      "SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1"
    ).first<{ created_at: string }>();

    const mostAccessed = await env.DB.prepare(
      "SELECT id, content, access_count FROM memories ORDER BY access_count DESC LIMIT 3"
    ).all();

    const stats = {
      total_memories: total?.count || 0,
      by_category: byCategory.results,
      by_source: bySource.results,
      by_importance: byImportance.results,
      stale_memories: staleCount?.count || 0,
      oldest_memory: oldest?.created_at || null,
      newest_memory: newest?.created_at || null,
      most_accessed: mostAccessed.results,
      behavior_mode: mode,
      categories_configured: categories,
    };

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(stats, null, 2) },
      ],
    };
  });

  // ── MCP Prompt: memory-instructions ───────────────────────────────
  const promptText = {
    proactive: `You have access to a persistent memory store that remembers things across conversations.

**At the start of every conversation:**
- Call recall() with context about what the user is discussing to check for relevant memories
- Reference relevant memories naturally — don't list them mechanically

**During conversation:**
- When you learn something new about the user (preferences, facts, people, health, projects), store it immediately with store_memory()
- When the user corrects previous information, use update_memory() on the existing memory — don't create duplicates
- Assign importance thoughtfully: 5 for critical info (allergies, key decisions), 3 for normal facts, 1 for trivia

**Before ending a session:**
- Store any key facts, preferences, or decisions that came up
- If the user shared something personal or important, make sure it's stored

Available categories: ${categories.join(", ")}`,

    balanced: `You have access to a persistent memory store.

- Use recall() when the current topic might benefit from past context
- Store key facts and preferences with store_memory() when they come up naturally
- Use update_memory() to modify existing memories rather than creating duplicates
- Importance: 5=critical, 3=normal, 1=trivial

Available categories: ${categories.join(", ")}`,

    manual: `You have access to a persistent memory store. Use it only when the user explicitly asks you to remember or recall something.

Available tools: store_memory, recall, update_memory, list_recent, search_by_tag, forget, review_stale, memory_stats
Available categories: ${categories.join(", ")}`,
  };

  server.prompt(
    "memory-instructions",
    "Instructions for how to use the memory server. Read this at the start of every session.",
    {},
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: promptText[mode],
          },
        },
      ],
    })
  );

  return server;
}

// ── Nightly Consolidation (opt-in via cron trigger) ───────────────────
async function runConsolidation(env: Env) {
  const processed = new Set<string>();
  let mergeCount = 0;

  // Get all memory IDs
  const { results: allMemories } = await env.DB.prepare(
    "SELECT id, content, category, importance FROM memories ORDER BY created_at DESC"
  ).all();

  if (!allMemories || allMemories.length < 2) return;

  for (const memory of allMemories as Memory[]) {
    if (processed.has(memory.id.toString())) continue;
    if (mergeCount >= MAX_CONSOLIDATION_BATCHES) break;

    // Find similar memories using the stored vector
    let similar;
    try {
      similar = await env.VECTORIZE.queryById(memory.id.toString(), {
        topK: 5,
        returnMetadata: "all",
      });
    } catch {
      continue;
    }

    if (!similar.matches) continue;

    // Filter for high similarity, excluding self and already-processed
    const cluster = similar.matches.filter(
      (m) =>
        m.id !== memory.id.toString() &&
        m.score >= SIMILARITY_THRESHOLD &&
        !processed.has(m.id)
    );

    if (cluster.length === 0) continue;

    // Fetch full content for cluster members
    const clusterIds = [memory.id.toString(), ...cluster.map((c) => c.id)];
    const placeholders = clusterIds.map(() => "?").join(",");
    const { results: clusterMemories } = await env.DB.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    )
      .bind(...clusterIds)
      .all();

    if (!clusterMemories || clusterMemories.length < 2) continue;

    // Merge via Workers AI
    const memoriesText = (clusterMemories as Memory[])
      .map((m) => `- ${m.content} [importance: ${m.importance}]`)
      .join("\n");

    let merged: string;
    try {
      const aiResponse = await env.AI.run(CONSOLIDATION_MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are a memory consolidation assistant. Merge the following related memories into a single, richer memory that preserves ALL key information. Be concise but complete. Output ONLY the merged memory text, nothing else.",
          },
          {
            role: "user",
            content: `Merge these memories:\n\n${memoriesText}`,
          },
        ],
        max_tokens: 512,
        temperature: 0.3,
      });
      merged = (aiResponse as any).response;
    } catch {
      continue;
    }

    if (!merged || merged.length < 5) continue;

    // Determine merged metadata
    const maxImportance = Math.max(
      ...(clusterMemories as Memory[]).map((m) => m.importance)
    );
    const primaryCategory = memory.category;
    const allTags = new Set<string>();
    for (const m of clusterMemories as Memory[]) {
      for (const t of JSON.parse(m.tags || "[]")) {
        allTags.add(t);
      }
    }

    // Insert consolidated memory
    const result = await env.DB.prepare(
      "INSERT INTO memories (content, category, tags, importance, source, consolidated_from) VALUES (?, ?, ?, ?, 'consolidation', ?) RETURNING id"
    )
      .bind(
        merged,
        primaryCategory,
        JSON.stringify([...allTags]),
        maxImportance,
        JSON.stringify(clusterIds.map(Number))
      )
      .first<{ id: number }>();

    if (!result) continue;

    // Embed and upsert new vector
    const vector = await embed(env.AI, merged);
    await env.VECTORIZE.upsert([
      {
        id: result.id.toString(),
        values: vector,
        metadata: {
          category: primaryCategory,
          source: "consolidation",
          importance: maxImportance,
          timestamp: Date.now(),
        },
      },
    ]);

    // Delete old entries
    for (const cId of clusterIds) {
      await env.DB.prepare("DELETE FROM memories WHERE id = ?")
        .bind(Number(cId))
        .run();
      await env.VECTORIZE.deleteByIds([cId]);
    }

    // Mark as processed
    for (const cId of clusterIds) {
      processed.add(cId);
    }
    processed.add(result.id.toString());
    mergeCount++;
  }
}

// ── Auth Middleware ────────────────────────────────────────────────────
function checkAuth(request: Request, env: Env): Response | null {
  if (!env.MEMORY_SECRET) return null;

  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  const querySecret = url.searchParams.get("secret");

  const token = authHeader?.replace("Bearer ", "") || querySecret;

  if (token !== env.MEMORY_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

// ── Embedded Web UI ───────────────────────────────────────────────────
const EMBEDDED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--surface:#13131a;--surface2:#1a1a24;--border:#2a2a3a;--text:#e4e4ef;--text2:#8888a0;--accent:#a78bfa;--accent2:#7c3aed;--red:#ef4444;--green:#22c55e;--orange:#f59e0b;--blue:#3b82f6;--radius:10px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;overflow-x:hidden}
a{color:var(--accent);text-decoration:none}
button{cursor:pointer;font-family:inherit;border:none;background:none;color:inherit}
input,textarea,select{font-family:inherit;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:14px;outline:none;transition:border .2s}
input:focus,textarea:focus,select:focus{border-color:var(--accent)}
textarea{resize:vertical;min-height:80px}

/* Login */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.login-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px;max-width:400px;width:100%}
.login-box h1{font-size:24px;margin-bottom:8px;background:linear-gradient(135deg,var(--accent),#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.login-box p{color:var(--text2);font-size:14px;margin-bottom:24px}
.login-box label{display:block;font-size:13px;color:var(--text2);margin-bottom:6px;margin-top:16px}
.login-box input{width:100%;margin-bottom:4px}
.login-box .hint{font-size:12px;color:var(--text2)}
.btn{background:var(--accent2);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-full{width:100%;margin-top:24px;padding:12px}
.btn-sm{padding:6px 14px;font-size:13px}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text2)}
.btn-ghost:hover{border-color:var(--accent);color:var(--text)}
.btn-danger{background:var(--red)}
.btn-danger:hover{opacity:.85}
.error-msg{color:var(--red);font-size:13px;margin-top:8px;display:none}

/* App Layout */
.app{display:none;height:100vh;flex-direction:column}
.topbar{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.topbar h1{font-size:18px;background:linear-gradient(135deg,var(--accent),#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-right:auto;white-space:nowrap}
.search-box{flex:1;max-width:500px;position:relative}
.search-box input{width:100%;padding-left:36px}
.search-box svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--text2)}
.topbar .disconnect{font-size:12px;color:var(--text2);cursor:pointer;padding:6px 10px;border:1px solid var(--border);border-radius:6px}
.topbar .disconnect:hover{border-color:var(--red);color:var(--red)}

.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:220px;border-right:1px solid var(--border);padding:16px;overflow-y:auto;flex-shrink:0;background:var(--surface)}
.sidebar h3{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:10px}
.cat-list{list-style:none;margin-bottom:20px}
.cat-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px;color:var(--text2);transition:all .15s}
.cat-item:hover,.cat-item.active{background:var(--surface2);color:var(--text)}
.cat-item.active{border-left:3px solid var(--accent);padding-left:7px}
.cat-count{font-size:12px;background:var(--surface2);padding:2px 8px;border-radius:10px;min-width:28px;text-align:center}
.cat-item.active .cat-count{background:var(--accent2);color:#fff}
.stat-card{background:var(--surface2);border-radius:10px;padding:14px;margin-bottom:8px}
.stat-card .label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)}
.stat-card .value{font-size:22px;font-weight:700;margin-top:4px}

.content{flex:1;overflow-y:auto;padding:20px}
.content-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.content-header h2{font-size:16px;color:var(--text2)}
.memory-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.memory-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;cursor:pointer;transition:border .2s,transform .15s}
.memory-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.memory-card .mc-top{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.badge{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge-cat{background:var(--accent2);color:#fff}
.badge-imp{background:var(--surface2);color:var(--orange)}
.mc-content{font-size:14px;line-height:1.6;color:var(--text);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.mc-meta{display:flex;align-items:center;gap:12px;margin-top:12px;font-size:12px;color:var(--text2)}
.mc-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.tag{font-size:11px;padding:2px 8px;background:var(--surface2);border-radius:4px;color:var(--text2)}
.mc-score{margin-left:auto;font-weight:600;color:var(--accent)}

/* Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center;padding:20px}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:600px;width:100%;max-height:90vh;overflow-y:auto}
.modal h2{font-size:18px;margin-bottom:20px}
.modal label{display:block;font-size:13px;color:var(--text2);margin-bottom:6px;margin-top:14px}
.modal input,.modal textarea,.modal select{width:100%}
.modal-actions{display:flex;gap:10px;margin-top:24px;justify-content:flex-end}
.imp-stars{display:flex;gap:4px;margin-top:6px}
.imp-star{width:28px;height:28px;border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;transition:all .15s}
.imp-star.active{background:var(--orange);border-color:var(--orange);color:#000}

/* Empty state */
.empty{text-align:center;padding:60px 20px;color:var(--text2)}
.empty svg{width:48px;height:48px;margin-bottom:16px;opacity:.4}
.empty p{font-size:14px}

/* Loading */
.loading{text-align:center;padding:40px;color:var(--text2)}
.spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}

/* Responsive */
@media(max-width:768px){
  .sidebar{display:none}
  .memory-grid{grid-template-columns:1fr}
  .topbar{flex-wrap:wrap}
  .search-box{order:3;max-width:100%;flex-basis:100%}
}
</style>
</head>
<body>

<!-- Login Screen -->
<div class="login-wrap" id="loginScreen">
  <div class="login-box">
    <h1>Memory</h1>
    <p>Enter your secret to access your memories.</p>
    <div id="remoteFields" style="display:none">
      <label>Server URL</label>
      <input type="url" id="serverUrl" placeholder="https://your-server.workers.dev">
      <div class="hint">The URL of your Memory server</div>
    </div>
    <label>Secret</label>
    <input type="password" id="secretInput" placeholder="Your MEMORY_SECRET">
    <div class="error-msg" id="loginError"></div>
    <button class="btn btn-full" onclick="doLogin()">Connect</button>
    <div style="text-align:center;margin-top:16px">
      <button class="btn-ghost btn-sm" id="toggleRemote" onclick="toggleRemote()" style="font-size:12px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;color:var(--text2)">Connect to remote server</button>
    </div>
  </div>
</div>

<!-- App -->
<div class="app" id="app">
  <div class="topbar">
    <h1>Memory</h1>
    <div class="search-box">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" id="searchInput" placeholder="Search memories..." onkeydown="if(event.key==='Enter')doSearch()">
    </div>
    <button class="btn btn-sm" onclick="openNewModal()">+ New</button>
    <button class="disconnect" onclick="doLogout()">Disconnect</button>
  </div>
  <div class="main">
    <div class="sidebar">
      <h3>Categories</h3>
      <ul class="cat-list" id="catList"></ul>
      <h3>Overview</h3>
      <div id="statsArea"></div>
    </div>
    <div class="content" id="contentArea">
      <div class="loading"><div class="spinner"></div>Loading memories...</div>
    </div>
  </div>
</div>

<!-- View/Edit Modal -->
<div class="modal-overlay" id="viewModal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h2 id="modalTitle">Memory</h2>
    <label>Content</label>
    <textarea id="mContent" rows="4"></textarea>
    <label>Category</label>
    <select id="mCategory"></select>
    <label>Tags (comma-separated)</label>
    <input type="text" id="mTags" placeholder="tag1, tag2">
    <label>Importance</label>
    <div class="imp-stars" id="mImpStars"></div>
    <div class="mc-meta" id="mMeta" style="margin-top:16px"></div>
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" id="mDeleteBtn" onclick="doDelete()">Delete</button>
      <button class="btn-ghost btn-sm" onclick="closeModal()" style="border:1px solid var(--border);border-radius:8px;padding:6px 14px">Cancel</button>
      <button class="btn btn-sm" id="mSaveBtn" onclick="doSave()">Save</button>
    </div>
  </div>
</div>

<script>
let BASE='';let SECRET='';let CATEGORIES=[];let ALL_MEMORIES=[];let CURRENT_CAT=null;let EDITING_ID=null;let IMPORTANCE=3;let IS_SEARCH=false;

function isEmbedded(){return !window.location.search.includes('remote=1')&&!document.getElementById('remoteFields').style.display!=='none'||window.location.pathname==='/'}
function getBase(){return BASE||window.location.origin}

function toggleRemote(){
  const f=document.getElementById('remoteFields');
  const b=document.getElementById('toggleRemote');
  if(f.style.display==='none'){f.style.display='block';b.textContent='Use embedded server'}
  else{f.style.display='none';b.textContent='Connect to remote server'}
}

async function doLogin(){
  const urlInput=document.getElementById('serverUrl');
  const secretInput=document.getElementById('secretInput');
  const errEl=document.getElementById('loginError');
  errEl.style.display='none';
  SECRET=secretInput.value.trim();
  if(!SECRET){errEl.textContent='Secret is required';errEl.style.display='block';return}
  const remoteVisible=document.getElementById('remoteFields').style.display!=='none';
  if(remoteVisible){
    BASE=urlInput.value.trim().replace(/\\/$/,'');
    if(!BASE){errEl.textContent='Server URL is required';errEl.style.display='block';return}
  }else{BASE=window.location.origin}
  try{
    const r=await api('/api/categories');
    CATEGORIES=r.categories;
    localStorage.setItem('memory_base',BASE);
    localStorage.setItem('memory_secret',SECRET);
    showApp();
  }catch(e){errEl.textContent=e.message||'Connection failed';errEl.style.display='block'}
}

function doLogout(){
  localStorage.removeItem('memory_base');localStorage.removeItem('memory_secret');
  document.getElementById('app').style.display='none';
  document.getElementById('loginScreen').style.display='flex';
}

async function api(path,opts={}){
  const url=getBase()+path;
  const headers={'Authorization':'Bearer '+SECRET,'Content-Type':'application/json',...(opts.headers||{})};
  const r=await fetch(url,{...opts,headers});
  if(r.status===401)throw new Error('Invalid secret');
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Request failed')}
  return r.json();
}

async function showApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='flex';
  await Promise.all([loadMemories(),loadStats()]);
  buildCategories();
}

async function loadMemories(cat){
  CURRENT_CAT=cat||null;IS_SEARCH=false;
  const params=new URLSearchParams({limit:'100',sort:'created_at',order:'desc'});
  if(cat)params.set('category',cat);
  const data=await api('/api/memories?'+params);
  ALL_MEMORIES=data.memories;
  renderMemories(ALL_MEMORIES);
  buildCategories();
}

async function loadStats(){
  try{
    const s=await api('/api/stats');
    const area=document.getElementById('statsArea');
    area.innerHTML=
      '<div class="stat-card"><div class="label">Total</div><div class="value">'+s.total_memories+'</div></div>'+
      '<div class="stat-card"><div class="label">Stale (90d)</div><div class="value">'+s.stale_memories+'</div></div>';
    if(!CATEGORIES.length)CATEGORIES=s.categories_configured;
    window._stats=s;
  }catch(e){console.error('stats',e)}
}

function buildCategories(){
  const list=document.getElementById('catList');
  const counts={};
  ALL_MEMORIES.forEach(m=>{counts[m.category]=(counts[m.category]||0)+1});
  let html='<li class="cat-item'+(CURRENT_CAT===null?' active':'')+'" onclick="loadMemories()"><span>All</span><span class="cat-count">'+(window._stats?.total_memories||ALL_MEMORIES.length)+'</span></li>';
  CATEGORIES.forEach(c=>{
    const ct=counts[c]||0;
    const statCt=window._stats?.by_category?.find(x=>x.category===c)?.count||ct;
    html+='<li class="cat-item'+(CURRENT_CAT===c?' active':'')+'" onclick="loadMemories(\''+c+'\')"><span>'+c+'</span><span class="cat-count">'+statCt+'</span></li>';
  });
  list.innerHTML=html;
}

function renderMemories(memories){
  const area=document.getElementById('contentArea');
  if(!memories.length){
    area.innerHTML='<div class="empty"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"/></svg><p>'+(IS_SEARCH?'No memories match your search.':'No memories yet.')+'</p></div>';
    return;
  }
  const header='<div class="content-header"><h2>'+(IS_SEARCH?'Search Results ('+memories.length+')':CURRENT_CAT?CURRENT_CAT+' ('+memories.length+')':'All Memories ('+memories.length+')')+'</h2></div>';
  let cards='';
  memories.forEach(m=>{
    const stars='&#9733;'.repeat(m.importance)+'&#9734;'.repeat(5-m.importance);
    const tags=m.tags.map(t=>'<span class="tag">'+esc(t)+'</span>').join('');
    const date=new Date(m.created_at+'Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
    const score=m.score?'<span class="mc-score">'+Math.round(m.score*100)+'%</span>':'';
    cards+='<div class="memory-card" onclick="openView('+m.id+')">'+
      '<div class="mc-top"><span class="badge badge-cat">'+esc(m.category)+'</span><span class="badge badge-imp">'+stars+'</span></div>'+
      '<div class="mc-content">'+esc(m.content)+'</div>'+
      (tags?'<div class="mc-tags">'+tags+'</div>':'')+
      '<div class="mc-meta"><span>'+date+'</span><span>'+m.access_count+' recalls</span>'+score+'</div></div>';
  });
  area.innerHTML=header+'<div class="memory-grid">'+cards+'</div>';
}

async function doSearch(){
  const q=document.getElementById('searchInput').value.trim();
  if(!q){loadMemories(CURRENT_CAT);return}
  IS_SEARCH=true;
  document.getElementById('contentArea').innerHTML='<div class="loading"><div class="spinner"></div>Searching...</div>';
  try{
    const body={query:q,limit:20};
    if(CURRENT_CAT)body.category=CURRENT_CAT;
    const results=await api('/api/recall',{method:'POST',body:JSON.stringify(body)});
    ALL_MEMORIES=results;
    renderMemories(results);
  }catch(e){document.getElementById('contentArea').innerHTML='<div class="empty"><p>Search failed: '+esc(e.message)+'</p></div>'}
}

function openView(id){
  const m=ALL_MEMORIES.find(x=>x.id===id);if(!m)return;
  EDITING_ID=id;IMPORTANCE=m.importance;
  document.getElementById('modalTitle').textContent='Memory #'+id;
  document.getElementById('mContent').value=m.content;
  buildCatSelect(m.category);
  document.getElementById('mTags').value=m.tags.join(', ');
  buildImpStars();
  document.getElementById('mMeta').innerHTML=
    'Created: '+new Date(m.created_at+'Z').toLocaleString()+' &middot; '+
    'Source: '+m.source+' &middot; '+
    'Recalled: '+m.access_count+' times';
  document.getElementById('mDeleteBtn').style.display='inline-block';
  document.getElementById('mSaveBtn').textContent='Save';
  document.getElementById('viewModal').classList.add('open');
}

function openNewModal(){
  EDITING_ID=null;IMPORTANCE=3;
  document.getElementById('modalTitle').textContent='New Memory';
  document.getElementById('mContent').value='';
  buildCatSelect('general');
  document.getElementById('mTags').value='';
  buildImpStars();
  document.getElementById('mMeta').innerHTML='';
  document.getElementById('mDeleteBtn').style.display='none';
  document.getElementById('mSaveBtn').textContent='Store';
  document.getElementById('viewModal').classList.add('open');
}

function closeModal(){document.getElementById('viewModal').classList.remove('open')}

function buildCatSelect(sel){
  const s=document.getElementById('mCategory');
  s.innerHTML=CATEGORIES.map(c=>'<option value="'+c+'"'+(c===sel?' selected':'')+'>'+c+'</option>').join('');
}

function buildImpStars(){
  const wrap=document.getElementById('mImpStars');
  wrap.innerHTML='';
  for(let i=1;i<=5;i++){
    const el=document.createElement('div');
    el.className='imp-star'+(i<=IMPORTANCE?' active':'');
    el.textContent=i;
    el.onclick=()=>{IMPORTANCE=i;buildImpStars()};
    wrap.appendChild(el);
  }
}

async function doSave(){
  const content=document.getElementById('mContent').value.trim();
  if(!content)return;
  const category=document.getElementById('mCategory').value;
  const tags=document.getElementById('mTags').value.split(',').map(t=>t.trim()).filter(Boolean);
  try{
    if(EDITING_ID){
      await api('/api/memories/'+EDITING_ID,{method:'PUT',body:JSON.stringify({content,category,tags,importance:IMPORTANCE})});
    }else{
      await api('/api/memories',{method:'POST',body:JSON.stringify({content,category,tags,importance:IMPORTANCE,source:'web'})});
    }
    closeModal();
    await loadMemories(CURRENT_CAT);
    await loadStats();
  }catch(e){alert(e.message)}
}

async function doDelete(){
  if(!EDITING_ID||!confirm('Delete this memory permanently?'))return;
  try{
    await api('/api/memories/'+EDITING_ID,{method:'DELETE'});
    closeModal();
    await loadMemories(CURRENT_CAT);
    await loadStats();
  }catch(e){alert(e.message)}
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

// Auto-login from localStorage
(async()=>{
  const b=localStorage.getItem('memory_base');
  const s=localStorage.getItem('memory_secret');
  if(s){
    BASE=b||window.location.origin;
    SECRET=s;
    try{
      const r=await api('/api/categories');
      CATEGORIES=r.categories;
      showApp();
    }catch(e){
      document.getElementById('loginScreen').style.display='flex';
    }
  }else{
    document.getElementById('loginScreen').style.display='flex';
  }
})();
<\/script>
</body>
</html>`;

// ── Export ─────────────────────────────────────────────────────────────
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(request),
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          name: "Memory",
          version: "2.1.0",
          behavior: getBehavior(env),
          categories: getCategories(env),
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // Embedded web UI
    if (url.pathname === "/") {
      return new Response(EMBEDDED_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // REST API
    if (url.pathname.startsWith("/api/")) {
      const authResponse = checkAuth(request, env);
      if (authResponse) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              ...cors(request),
            },
          }
        );
      }
      return handleApi(request, env, url);
    }

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      const authResponse = checkAuth(request, env);
      if (authResponse) return authResponse;

      const server = createServer(env);
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  // Cron trigger handler (opt-in — uncomment [triggers] in wrangler.toml)
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runConsolidation(env));
  },
};
