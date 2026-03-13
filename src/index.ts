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

// ── Export ─────────────────────────────────────────────────────────────
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          name: "Memory",
          version: "2.0.0",
          behavior: getBehavior(env),
          categories: getCategories(env),
        }),
        { headers: { "content-type": "application/json" } }
      );
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
