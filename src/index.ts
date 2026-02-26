import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MEMORY_SECRET: string;
}

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const CATEGORIES = [
  "general",
  "personal",
  "preference",
  "emotional",
  "technical",
  "reflection",
  "fact",
  "conversation",
] as const;

const SOURCES = [
  "claude_code",
  "claude_desktop",
  "claude_web",
  "claude_mobile",
  "api",
  "unknown",
] as const;

// Generate embedding for a piece of text
async function embed(ai: Ai, text: string): Promise<number[]> {
  const resp = await ai.run(EMBEDDING_MODEL, { text: [text] });
  return (resp as any).data[0];
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Memory",
    version: "1.0.0",
  });

  // ── store_memory ──────────────────────────────────────────────
  server.tool(
    "store_memory",
    "Store a new memory. Use this to remember things across conversations — facts, preferences, observations, anything worth keeping.",
    {
      content: z.string().describe("The memory content to store"),
      category: z
        .enum(CATEGORIES)
        .default("general")
        .describe("Category for the memory"),
      tags: z
        .array(z.string())
        .default([])
        .describe("Optional tags for filtering"),
      source: z
        .enum(SOURCES)
        .default("unknown")
        .describe("Which client stored this memory"),
    },
    async ({ content, category, tags, source }) => {
      const result = await env.DB.prepare(
        "INSERT INTO memories (content, category, tags, source) VALUES (?, ?, ?, ?) RETURNING id"
      )
        .bind(content, category, JSON.stringify(tags), source)
        .first<{ id: number }>();

      if (!result) {
        return {
          content: [{ type: "text" as const, text: "Failed to store memory." }],
        };
      }

      // Generate embedding and store in Vectorize
      const vector = await embed(env.AI, content);
      await env.VECTORIZE.upsert([
        {
          id: result.id.toString(),
          values: vector,
          metadata: {
            category,
            source,
            timestamp: Date.now(),
          },
        },
      ]);

      return {
        content: [
          {
            type: "text" as const,
            text: `Memory stored (id: ${result.id}, category: ${category}).`,
          },
        ],
      };
    }
  );

  // ── recall ────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Search memories by meaning. Use natural language queries like 'what programming languages does the user prefer' or 'past debugging issues'.",
    {
      query: z.string().describe("Natural language search query"),
      category: z
        .enum(CATEGORIES)
        .optional()
        .describe("Optional: filter by category"),
      limit: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of results to return"),
    },
    async ({ query, category, limit }) => {
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
        // Fallback: keyword search in D1
        let fallbackQuery = "SELECT * FROM memories WHERE content LIKE ?";
        const fallbackBinds: any[] = [`%${query}%`];

        if (category) {
          fallbackQuery += " AND category = ?";
          fallbackBinds.push(category);
        }

        fallbackQuery += " ORDER BY created_at DESC LIMIT ?";
        fallbackBinds.push(limit);

        const { results: fallbackResults } = await env.DB.prepare(fallbackQuery)
          .bind(...fallbackBinds)
          .all();

        if (fallbackResults && fallbackResults.length > 0) {
          const formatted = (fallbackResults as any[]).map((m) => ({
            id: m.id,
            score: "keyword_match",
            content: m.content,
            category: m.category,
            tags: JSON.parse(m.tags || "[]"),
            source: m.source,
            created_at: m.created_at,
          }));

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(formatted, null, 2) },
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

      // Fetch full records from D1
      const ids = vectorResults.matches.map((m) => m.id);
      const placeholders = ids.map(() => "?").join(",");
      const { results: memories } = await env.DB.prepare(
        `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY created_at DESC`
      )
        .bind(...ids)
        .all();

      const enriched = vectorResults.matches
        .map((match) => {
          const memory = (memories as any[])?.find(
            (m) => m.id.toString() === match.id
          );
          if (!memory) return null;
          return {
            id: memory.id,
            score: Math.round(match.score * 100) / 100,
            content: memory.content,
            category: memory.category,
            tags: JSON.parse(memory.tags || "[]"),
            source: memory.source,
            created_at: memory.created_at,
          };
        })
        .filter(Boolean);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(enriched, null, 2),
          },
        ],
      };
    }
  );

  // ── list_recent ───────────────────────────────────────────────
  server.tool(
    "list_recent",
    "List the most recent memories, optionally filtered by category.",
    {
      category: z
        .enum(CATEGORIES)
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
        query += " WHERE category = ?";
        binds.push(category);
      }

      query += " ORDER BY created_at DESC LIMIT ?";
      binds.push(limit);

      const { results } = await env.DB.prepare(query).bind(...binds).all();

      const formatted = (results as any[]).map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        tags: JSON.parse(m.tags || "[]"),
        source: m.source,
        created_at: m.created_at,
      }));

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

  // ── search_by_tag ─────────────────────────────────────────────
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
        `SELECT * FROM memories WHERE tags LIKE ? ORDER BY created_at DESC LIMIT ?`
      )
        .bind(`%"${tag}"%`, limit)
        .all();

      const formatted = (results as any[]).map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        tags: JSON.parse(m.tags || "[]"),
        source: m.source,
        created_at: m.created_at,
      }));

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

  // ── forget ────────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete a memory by ID.",
    {
      id: z.number().describe("The memory ID to delete"),
    },
    async ({ id }) => {
      await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
      await env.VECTORIZE.deleteByIds([id.toString()]);

      return {
        content: [
          { type: "text" as const, text: `Memory ${id} forgotten.` },
        ],
      };
    }
  );

  // ── memory_stats ──────────────────────────────────────────────
  server.tool(
    "memory_stats",
    "Get statistics about stored memories.",
    {},
    async () => {
      const total = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM memories"
      ).first<{ count: number }>();
      const byCategory = await env.DB.prepare(
        "SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC"
      ).all();
      const bySource = await env.DB.prepare(
        "SELECT source, COUNT(*) as count FROM memories GROUP BY source ORDER BY count DESC"
      ).all();
      const oldest = await env.DB.prepare(
        "SELECT created_at FROM memories ORDER BY created_at ASC LIMIT 1"
      ).first<{ created_at: string }>();
      const newest = await env.DB.prepare(
        "SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1"
      ).first<{ created_at: string }>();

      const stats = {
        total_memories: total?.count || 0,
        by_category: byCategory.results,
        by_source: bySource.results,
        oldest_memory: oldest?.created_at || null,
        newest_memory: newest?.created_at || null,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(stats, null, 2) },
        ],
      };
    }
  );

  return server;
}

// ── Auth middleware ────────────────────────────────────────────────
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

// ── Export ─────────────────────────────────────────────────────────
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
          version: "1.0.0",
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
};
