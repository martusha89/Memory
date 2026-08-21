import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  contentHash,
  MAX_CONTENT_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  isProjectionCurrent,
  normalizeTags,
  positiveInt,
  scoreRecallCandidate,
  validateContent,
  validateQuery,
} from "./memory-core";

// ── Types ─────────────────────────────────────────────────────────────
interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MEMORY_SECRET: string;
  MEMORY_CATEGORIES?: string;
}

interface Memory {
  id: number;
  content: string;
  category: string;
  tags: string;
  importance: number;
  source: string;
  pinned: number;
  access_count: number;
  last_accessed_at: string | null;
  consolidated_from: string | null;
  status: "active" | "superseded" | "disputed" | "retracted";
  record_version: number;
  content_hash: string;
  dedupe_key: string | null;
  indexed_version: number | null;
  index_status: "pending" | "ready" | "failed";
  created_at: string;
  updated_at: string;
}

interface IndexOutboxItem {
  id: number;
  memory_id: number;
  record_version: number;
  operation: "upsert" | "delete";
  content_hash: string;
  state: "pending" | "processing" | "complete" | "failed";
  attempts: number;
  locked_at: string | null;
}

interface RecallCandidate {
  memory: Memory;
  semanticScore: number;
  lexicalScore: number;
}

// ── Constants ─────────────────────────────────────────────────────────
const VERSION = "3.0.0";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const SIMILARITY_THRESHOLD = 0.85;
// Vectorize always returns the topK nearest neighbors no matter how far
// away they are — without a floor, recall returns junk and the keyword
// fallback is unreachable.
const MIN_RECALL_SCORE = 0.55;
const STALE_DAYS = 90;
// Retained only so the legacy implementation below remains buildable while
// deployments migrate. It is deliberately unreachable from fetch/scheduled.
const CONSOLIDATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const MAX_CONSOLIDATION_BATCHES = 20;
const INDEX_BATCH_SIZE = 25;

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

// ── Helpers ───────────────────────────────────────────────────────────
function getCategories(env: Env): string[] {
  if (env.MEMORY_CATEGORIES) {
    return env.MEMORY_CATEGORIES.split(",").map((c) => c.trim().toLowerCase());
  }
  return [...DEFAULT_CATEGORIES];
}

async function embed(ai: Ai, text: string): Promise<number[]> {
  const resp = await ai.run(EMBEDDING_MODEL, { text: [text] });
  return (resp as any).data[0];
}

function safeJsonArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeNumberArray(value: string | null): number[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.map(Number).filter((item) => Number.isSafeInteger(item))
      : [];
  } catch {
    return [];
  }
}

function formatMemory(m: Memory) {
  return {
    id: m.id,
    content: m.content,
    category: m.category,
    tags: safeJsonArray(m.tags),
    importance: m.importance,
    source: m.source,
    pinned: !!m.pinned,
    access_count: m.access_count,
    last_accessed_at: m.last_accessed_at,
    created_at: m.created_at,
    updated_at: m.updated_at,
    consolidated_from: m.consolidated_from
      ? safeNumberArray(m.consolidated_from)
      : null,
    status: m.status,
    record_version: m.record_version,
    indexed_version: m.indexed_version,
    index_status: m.index_status,
  };
}

async function markOutboxFailure(env: Env, item: IndexOutboxItem, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown indexing error";
  const delayMinutes = Math.min(2 ** Math.min(item.attempts, 8), 360);
  await env.DB.prepare(
    `UPDATE index_outbox
     SET state = 'failed', last_error = ?, next_attempt_at = datetime('now', ?), locked_at = NULL
     WHERE id = ?`
  )
    .bind(message, `+${delayMinutes} minutes`, item.id)
    .run();
  const current = await env.DB.prepare("SELECT record_version FROM memories WHERE id = ?")
    .bind(item.memory_id)
    .first<{ record_version: number }>();
  if (current?.record_version === item.record_version) {
    await env.DB.prepare("UPDATE memories SET index_status = 'failed' WHERE id = ?")
      .bind(item.memory_id)
      .run();
  }
}

async function processIndexOutbox(
  env: Env,
  memoryId?: number,
  limit = INDEX_BATCH_SIZE
): Promise<{ processed: number; failed: number }> {
  let query = `SELECT * FROM index_outbox
    WHERE (
      (state IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')))
      OR (state = 'processing' AND locked_at < datetime('now', '-10 minutes'))
    )`;
  const binds: number[] = [];
  if (memoryId !== undefined) {
    query += " AND memory_id = ?";
    binds.push(memoryId);
  }
  query += " ORDER BY created_at ASC, id ASC LIMIT ?";
  binds.push(limit);
  const { results } = await env.DB.prepare(query).bind(...binds).all<IndexOutboxItem>();
  let processed = 0;
  let failed = 0;

  for (const candidate of results || []) {
    const item = await env.DB.prepare(
      `UPDATE index_outbox
       SET state = 'processing', attempts = attempts + 1, last_error = NULL, locked_at = datetime('now')
       WHERE id = ? AND (
         state IN ('pending', 'failed')
         OR (state = 'processing' AND locked_at < datetime('now', '-10 minutes'))
       )
       RETURNING *`
    )
      .bind(candidate.id)
      .first<IndexOutboxItem>();
    if (!item) continue;

    try {
      if (item.operation === "delete") {
        await env.VECTORIZE.deleteByIds([item.memory_id.toString()]);
      } else {
        const memory = await env.DB.prepare("SELECT * FROM memories WHERE id = ?")
          .bind(item.memory_id)
          .first<Memory>();
        if (!memory || memory.record_version !== item.record_version) {
          await env.DB.prepare(
            "UPDATE index_outbox SET state = 'complete', completed_at = datetime('now'), locked_at = NULL WHERE id = ?"
          )
            .bind(item.id)
            .run();
          processed++;
          continue;
        }
        const hash = memory.content_hash || (await contentHash(memory.content));
        if (!memory.content_hash) {
          await env.DB.batch([
            env.DB.prepare("UPDATE memories SET content_hash = ? WHERE id = ?").bind(
              hash,
              memory.id
            ),
            env.DB.prepare(
              "UPDATE OR IGNORE memories SET dedupe_key = ? WHERE id = ? AND dedupe_key IS NULL"
            ).bind(hash, memory.id),
          ]);
        }
        const vector = await embed(env.AI, memory.content);
        await env.VECTORIZE.upsert([
          {
            id: memory.id.toString(),
            values: vector,
            metadata: {
              category: memory.category,
              source: memory.source,
              importance: memory.importance,
              status: memory.status,
              record_version: memory.record_version,
              content_hash: hash,
              timestamp: Date.now(),
            },
          },
        ]);
        await env.DB.prepare(
          `UPDATE memories SET indexed_version = ?, index_status = 'ready'
           WHERE id = ? AND record_version = ?`
        )
          .bind(memory.record_version, memory.id, memory.record_version)
          .run();
      }
      await env.DB.prepare(
        "UPDATE index_outbox SET state = 'complete', completed_at = datetime('now'), next_attempt_at = NULL, locked_at = NULL WHERE id = ?"
      )
        .bind(item.id)
        .run();
      processed++;
    } catch (error) {
      failed++;
      await markOutboxFailure(env, item, error);
    }
  }

  return { processed, failed };
}

function intParam(
  url: URL,
  name: string,
  def: number,
  max?: number
): number {
  const raw = parseInt(url.searchParams.get(name) || "");
  let val = Number.isFinite(raw) ? raw : def;
  if (val < 0) val = def;
  if (max !== undefined) val = Math.min(val, max);
  return val;
}

async function touchAccess(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  await db
    .prepare(
      `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id IN (${ph})`
    )
    .bind(...ids)
    .run();
}

// ── Shared Recall (used by REST + MCP) ───────────────────────────────
async function recallMemories(
  env: Env,
  query: string,
  category: string | undefined,
  limit: number
): Promise<any[]> {
  const queryVector = await embed(env.AI, query);
  const queryOptions: VectorizeQueryOptions = {
    topK: Math.min(Math.max(limit * 8, 20), 100),
    returnMetadata: "all",
  };
  if (category) queryOptions.filter = { category };

  const vectorResults = await env.VECTORIZE.query(queryVector, queryOptions);
  const matches = (vectorResults.matches || []).filter((m) => m.score >= MIN_RECALL_SCORE);
  const candidates = new Map<number, RecallCandidate>();

  if (matches.length > 0) {
    const ids = matches.map((match) => Number(match.id)).filter(Number.isSafeInteger);
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT * FROM memories WHERE id IN (${ph}) AND status = 'active'`
      )
        .bind(...ids)
        .all<Memory>();
      const byId = new Map((results || []).map((memory) => [memory.id, memory]));
      for (const match of matches) {
        const id = Number(match.id);
        const memory = byId.get(id);
        if (!memory) continue;
        const metadata = (match.metadata || {}) as Record<string, unknown>;
        // v3 vectors are accepted only when they describe the current D1 version.
        if (!isProjectionCurrent(memory, metadata)) {
          continue;
        }
        candidates.set(id, { memory, semanticScore: match.score, lexicalScore: 0 });
      }
    }
  }

  // Always union lexical candidates with semantic candidates. FTS keeps D1-only
  // records discoverable while their Vectorize projection is pending or failed.
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
    .filter((token) => token.length > 1)
    .slice(0, 12);
  const lexicalLimit = Math.min(Math.max(limit * 8, 20), 100);
  let lexicalMemories: Memory[] = [];
  if (tokens.length > 0) {
    const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
    try {
      let sql = `SELECT m.* FROM memory_fts
        JOIN memories m ON m.id = memory_fts.rowid
        WHERE memory_fts MATCH ? AND m.status = 'active'`;
      const binds: unknown[] = [ftsQuery];
      if (category) {
        sql += " AND m.category = ?";
        binds.push(category);
      }
      sql += " ORDER BY bm25(memory_fts) LIMIT ?";
      binds.push(lexicalLimit);
      const { results } = await env.DB.prepare(sql).bind(...binds).all<Memory>();
      lexicalMemories = results || [];
    } catch {
      // Compatibility fallback for deployments that have not run the v3 FTS migration.
      const clauses = tokens.map(() => "lower(content) LIKE ?").join(" OR ");
      let sql = `SELECT * FROM memories WHERE status = 'active' AND (${clauses})`;
      const binds: unknown[] = tokens.map((token) => `%${token}%`);
      if (category) {
        sql += " AND category = ?";
        binds.push(category);
      }
      sql += " ORDER BY updated_at DESC LIMIT ?";
      binds.push(lexicalLimit);
      const { results } = await env.DB.prepare(sql).bind(...binds).all<Memory>();
      lexicalMemories = results || [];
    }
  }

  lexicalMemories.forEach((memory, index) => {
    const lexicalScore = 1 - index / Math.max(lexicalMemories.length, 1) * 0.3;
    const existing = candidates.get(memory.id);
    if (existing) existing.lexicalScore = lexicalScore;
    else candidates.set(memory.id, { memory, semanticScore: 0, lexicalScore });
  });

  const ranked = [...candidates.values()]
    .map(({ memory, semanticScore, lexicalScore }) => {
      const weightedScore = scoreRecallCandidate(
        semanticScore,
        lexicalScore,
        memory.importance
      );
      return {
        ...formatMemory(memory),
        score: semanticScore > 0 ? Math.round(semanticScore * 100) / 100 : null,
        lexical_score: lexicalScore > 0 ? Math.round(lexicalScore * 100) / 100 : null,
        weighted_score: Math.round(weightedScore * 100) / 100,
        match_type:
          semanticScore > 0 && lexicalScore > 0
            ? "hybrid"
            : semanticScore > 0
              ? "semantic"
              : "lexical",
      };
    })
    .sort((a, b) => b.weighted_score - a.weighted_score)
    .slice(0, limit);

  await touchAccess(env.DB, ranked.map((result) => result.id));
  return ranked;
}

// ── Shared Dedup Check (used by REST + MCP) ──────────────────────────
async function findDuplicate(
  env: Env,
  vector: number[],
  hash: string,
  category: string
): Promise<{ memory: Memory; similarity: number; kind: "exact" | "related" } | null> {
  const exact = await env.DB.prepare(
    "SELECT * FROM memories WHERE content_hash = ? AND status = 'active' ORDER BY id ASC LIMIT 1"
  )
    .bind(hash)
    .first<Memory>();
  if (exact) return { memory: exact, similarity: 1, kind: "exact" };

  const similar = await env.VECTORIZE.query(vector, {
    topK: 10,
    returnMetadata: "all",
    filter: { category },
  });
  const matches = (similar.matches || []).filter((m) => m.score >= SIMILARITY_THRESHOLD);
  if (matches.length === 0) return null;
  const ids = matches.map((match) => match.id);
  const ph = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM memories WHERE id IN (${ph}) AND status = 'active'`
  )
    .bind(...ids)
    .all<Memory>();
  const byId = new Map((results || []).map((memory) => [memory.id.toString(), memory]));
  for (const match of matches) {
    const existing = byId.get(match.id);
    if (!existing) continue;
    const metadata = (match.metadata || {}) as Record<string, unknown>;
    if (!isProjectionCurrent(existing, metadata)) {
      continue;
    }
    return { memory: existing, similarity: match.score, kind: "related" };
  }
  return null;
}

// ── Shared Stats (used by REST + MCP) ────────────────────────────────
async function getStatsData(env: Env, categories: string[]) {
  const [
    total,
    byCategory,
    bySource,
    byImportance,
    staleCount,
    oldest,
    newest,
    mostAccessed,
    indexBacklog,
  ] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) as count FROM memories WHERE status = 'active'"),
    env.DB.prepare(
      "SELECT category, COUNT(*) as count FROM memories WHERE status = 'active' GROUP BY category ORDER BY count DESC"
    ),
    env.DB.prepare(
      "SELECT source, COUNT(*) as count FROM memories WHERE status = 'active' GROUP BY source ORDER BY count DESC"
    ),
    env.DB.prepare(
      "SELECT importance, COUNT(*) as count FROM memories WHERE status = 'active' GROUP BY importance ORDER BY importance DESC"
    ),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE status = 'active' AND (
         (last_accessed_at IS NOT NULL AND last_accessed_at < datetime('now', '-90 days'))
         OR (last_accessed_at IS NULL AND created_at < datetime('now', '-90 days'))
       )`
    ),
    env.DB.prepare(
      "SELECT created_at FROM memories WHERE status = 'active' ORDER BY created_at ASC LIMIT 1"
    ),
    env.DB.prepare(
      "SELECT created_at FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    ),
    env.DB.prepare(
      "SELECT id, content, access_count FROM memories WHERE status = 'active' ORDER BY access_count DESC LIMIT 3"
    ),
    env.DB.prepare(
      "SELECT state, COUNT(*) as count FROM index_outbox WHERE state <> 'complete' GROUP BY state"
    ),
  ]);

  return {
    total_memories: (total.results[0] as any)?.count || 0,
    by_category: byCategory.results,
    by_source: bySource.results,
    by_importance: byImportance.results,
    stale_memories: (staleCount.results[0] as any)?.count || 0,
    oldest_memory: (oldest.results[0] as any)?.created_at || null,
    newest_memory: (newest.results[0] as any)?.created_at || null,
    most_accessed: mostAccessed.results,
    index_backlog: indexBacklog.results,
    categories_configured: categories,
  };
}

// ── Shared Stale Query (used by REST + MCP) ──────────────────────────
async function getStaleMemories(
  env: Env,
  days: number,
  limit: number
): Promise<Memory[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE status = 'active' AND (
       (last_accessed_at IS NOT NULL AND last_accessed_at < datetime('now', ?))
       OR (last_accessed_at IS NULL AND created_at < datetime('now', ?))
     )
     ORDER BY importance ASC, created_at ASC LIMIT ?`
  )
    .bind(`-${days} days`, `-${days} days`, limit)
    .all();
  return results as unknown as Memory[];
}

// ── CORS & Response Helpers ──────────────────────────────────────────
function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const ownOrigin = new URL(request.url).origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Same-origin browser access is enabled by default. Cross-origin clients
  // should use MCP or a non-browser HTTP client rather than reflected CORS.
  if (origin === ownOrigin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
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
    return jsonResp({ categories }, request);
  }

  // GET /api/stats
  if (path === "/api/stats" && method === "GET") {
    return jsonResp(await getStatsData(env, categories), request);
  }

  if (path === "/api/index/reconcile" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
    let limit: number;
    try {
      limit = positiveInt(body.limit, INDEX_BATCH_SIZE, 100);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "Invalid request", request);
    }
    return jsonResp(await processIndexOutbox(env, undefined, limit), request);
  }

  // GET /api/stale?days=90&limit=20
  if (path === "/api/stale" && method === "GET") {
    const days = intParam(url, "days", 90);
    const limit = intParam(url, "limit", 20, 50);
    const results = await getStaleMemories(env, days, limit);
    return jsonResp(results.map(formatMemory), request);
  }

  // POST /api/recall
  if (path === "/api/recall" && method === "POST") {
    const body = (await request.json()) as any;
    let query: string;
    let limit: number;
    try {
      query = validateQuery(body.query);
      limit = positiveInt(body.limit, 10, 20);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "Invalid request", request);
    }
    const { category } = body;

    if (category && !categories.includes(category)) {
      return apiError(
        `Invalid category "${category}". Available: ${categories.join(", ")}`,
        request
      );
    }

    return jsonResp(await recallMemories(env, query, category, limit), request);
  }

  // ── Memory CRUD: /api/memories ────────────────────────────────────
  const versionsMatch = path.match(/^\/api\/memories\/(\d+)\/versions$/);
  if (versionsMatch && method === "GET") {
    const memoryId = Number(versionsMatch[1]);
    const { results } = await env.DB.prepare(
      `SELECT memory_id, record_version, content, category, tags, importance,
        source, pinned, status, content_hash, change_kind, recorded_at
       FROM memory_versions WHERE memory_id = ? ORDER BY record_version DESC`
    )
      .bind(memoryId)
      .all();
    return jsonResp({ memory_id: memoryId, versions: results || [] }, request);
  }

  const memoryMatch = path.match(/^\/api\/memories(?:\/(\d+))?$/);
  if (memoryMatch) {
    const id = memoryMatch[1] ? parseInt(memoryMatch[1]) : null;

    // GET /api/memories — list with pagination
    if (method === "GET" && !id) {
      const category = url.searchParams.get("category");
      const limit = intParam(url, "limit", 50, 100);
      const offset = intParam(url, "offset", 0);
      const sort = url.searchParams.get("sort") || "created_at";
      const order =
        url.searchParams.get("order") === "asc" ? "ASC" : "DESC";

      let query = "SELECT * FROM memories WHERE status = 'active'";
      const binds: any[] = [];
      if (category) {
        if (!categories.includes(category))
          return apiError("Invalid category", request);
        query += " AND category = ?";
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

      let countQuery = "SELECT COUNT(*) as count FROM memories WHERE status = 'active'";
      const countBinds: any[] = [];
      if (category) {
        countQuery += " AND category = ?";
        countBinds.push(category);
      }
      const total = await env.DB.prepare(countQuery)
        .bind(...countBinds)
        .first<{ count: number }>();

      return jsonResp(
        {
          memories: (results as unknown as Memory[]).map(formatMemory),
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
      let content: string;
      let tags: string[];
      try {
        content = validateContent(body.content);
        tags = normalizeTags(body.tags ?? []);
      } catch (error) {
        return apiError(error instanceof Error ? error.message : "Invalid request", request);
      }
      const category = body.category ?? "general";
      const importance = body.importance ?? 3;
      const source = body.source ?? "api";
      const force = body.force === true;
      const pinned = body.pinned === true;
      if (!categories.includes(category))
        return apiError(
          `Invalid category "${category}". Available: ${categories.join(", ")}`,
          request
        );
      if (!Number.isInteger(importance) || importance < 1 || importance > 5)
        return apiError("importance must be an integer from 1-5", request);
      if (![...SOURCES, "web"].includes(source))
        return apiError("Invalid source", request);

      const vector = await embed(env.AI, content);
      const hash = await contentHash(content);

      // Only exact normalized duplicates are blocked. Semantic similarity is
      // advisory because a correction can be close to the claim it replaces.
      const dupe = await findDuplicate(env, vector, hash, category);
      if (!force && dupe?.kind === "exact") {
          return jsonResp(
            {
              duplicate: true,
              existing_id: dupe.memory.id,
              existing_content: dupe.memory.content,
              similarity: 100,
              message:
                "Exact normalized memory already exists. Send force=true to store a separate copy.",
            },
            request,
            409
          );
      }

      // `force` and `pinned` are independent decisions in v3.
      const result = await env.DB.prepare(
        "INSERT OR IGNORE INTO memories (content, category, tags, importance, source, pinned, content_hash, dedupe_key, index_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING *"
      )
        .bind(
          content,
          category,
          JSON.stringify(tags),
          importance,
          source,
          pinned ? 1 : 0,
          hash,
          force ? null : hash
        )
        .first<Memory>();

      if (!result) {
        const concurrent = await env.DB.prepare(
          "SELECT id, content FROM memories WHERE dedupe_key = ? AND status = 'active' LIMIT 1"
        )
          .bind(hash)
          .first<{ id: number; content: string }>();
        if (concurrent) {
          return jsonResp(
            {
              duplicate: true,
              existing_id: concurrent.id,
              existing_content: concurrent.content,
              similarity: 100,
              message: "Exact memory was stored concurrently.",
            },
            request,
            409
          );
        }
        return apiError("Failed to store memory", request, 500);
      }

      await processIndexOutbox(env, result.id, 5);
      const stored = await env.DB.prepare("SELECT * FROM memories WHERE id = ?")
        .bind(result.id)
        .first<Memory>();
      return jsonResp(
        {
          ...formatMemory(stored || result),
          related_memory:
            dupe?.kind === "related"
              ? {
                  id: dupe.memory.id,
                  content: dupe.memory.content,
                  similarity: Math.round(dupe.similarity * 100),
                  message: "Review as a possible duplicate, correction, or contradiction.",
                }
              : null,
        },
        request,
        201
      );
    }

    // PUT /api/memories/:id — update
    if (method === "PUT" && id) {
      const body = (await request.json()) as any;
      const { category } = body;

      if (category && !categories.includes(category))
        return apiError("Invalid category", request);
      if (
        body.importance !== undefined &&
        (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5)
      )
        return apiError("importance must be an integer from 1-5", request);

      const existing = await env.DB.prepare(
        "SELECT * FROM memories WHERE id = ?"
      )
        .bind(id)
        .first<Memory>();
      if (!existing)
        return apiError("Memory not found", request, 404);

      let newContent = existing.content;
      let newTags = existing.tags;
      try {
        if (body.content !== undefined) newContent = validateContent(body.content);
        if (body.tags !== undefined) newTags = JSON.stringify(normalizeTags(body.tags));
      } catch (error) {
        return apiError(error instanceof Error ? error.message : "Invalid request", request);
      }
      const newCategory = category ?? existing.category;
      const newImportance = body.importance ?? existing.importance;
      const newHash = await contentHash(newContent);
      if (existing.dedupe_key !== null) {
        const conflict = await env.DB.prepare(
          "SELECT id FROM memories WHERE dedupe_key = ? AND id <> ? AND status = 'active' LIMIT 1"
        )
          .bind(newHash, id)
          .first<{ id: number }>();
        if (conflict) {
          return apiError(`Update would duplicate memory ${conflict.id}`, request, 409);
        }
      }

      await env.DB.prepare(
        `UPDATE memories SET content = ?, category = ?, tags = ?, importance = ?,
          content_hash = ?, dedupe_key = CASE WHEN dedupe_key IS NULL THEN NULL ELSE ? END,
          record_version = record_version + 1,
          index_status = 'pending', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(newContent, newCategory, newTags, newImportance, newHash, newHash, id)
        .run();

      // Re-upsert when content OR vector metadata changed — Vectorize has
      // no metadata-only update, and stale category metadata silently
      // breaks category-filtered recall.
      await processIndexOutbox(env, id, 5);

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

      await env.DB.batch([
        env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM memory_versions WHERE memory_id = ?").bind(id),
        env.DB.prepare(
          "DELETE FROM memories_archive WHERE original_id = ? OR consolidated_into = ?"
        ).bind(id, id),
      ]);
      await processIndexOutbox(env, id, 5);

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
      `SELECT * FROM memories WHERE status = 'active' AND tags LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?`
    )
      .bind(`%"${tag}"%`, limit)
      .all();
    return jsonResp((results as unknown as Memory[]).map(formatMemory), request);
  }

  return apiError("Not found", request, 404);
}

// ── Tool Descriptions ─────────────────────────────────────────────────
const TOOL_DESC = {
  store: "Store a memory — facts, preferences, decisions, people, health details, project context. Duplicates are caught automatically (cosine similarity > 0.85).",
  recall: "Search memories by meaning, weighted by importance. Use natural language queries like 'what does the user prefer for X'. Falls back to keyword search if no semantic matches.",
  update: "Update an existing memory's content, category, tags, or importance. Use this when you learn new details about something already stored — don't create duplicates, update the existing memory instead. Re-embeds automatically.",
  review_stale: "List memories that haven't been accessed in a while. Use this to help the user clean up old, potentially outdated memories. Returns memories not recalled in the specified number of days.",
  stats: "Get statistics about the memory store — total count, breakdown by category and source, importance distribution, stale memory count, and storage health.",
};

// ── MCP Server ────────────────────────────────────────────────────────
function createServer(env: Env) {
  const server = new McpServer({
    name: "Memory",
    version: VERSION,
  });

  const categories = getCategories(env);

  // ── store_memory ──────────────────────────────────────────────────
  server.tool("store_memory", TOOL_DESC.store, {
    content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH).describe("The memory content to store"),
    category: z
      .string()
      .default("general")
      .describe(`Category: ${categories.join(", ")}`),
    tags: z
      .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
      .max(MAX_TAGS)
      .default([])
      .describe("Optional tags for filtering"),
    importance: z
      .number()
      .int()
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
    pinned: z
      .boolean()
      .default(false)
      .describe("Protect this memory from automated supersession or consolidation"),
  }, async ({ content, category, tags, importance, source, force, pinned }) => {
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
    const hash = await contentHash(content);
    const normalizedTags = normalizeTags(tags);

    // Dedup check
    const dupe = await findDuplicate(env, vector, hash, category);
    if (!force && dupe?.kind === "exact") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Exact normalized memory already exists (id: ${dupe.memory.id}):\n"${dupe.memory.content}"\n\nUse update_memory to modify it, or call store_memory with force=true to store a separate copy.`,
            },
          ],
        };
    }

    // D1 triggers atomically record the immutable version and outbox event.
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO memories (content, category, tags, importance, source, pinned, content_hash, dedupe_key, index_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id"
    )
      .bind(
        content,
        category,
        JSON.stringify(normalizedTags),
        importance,
        source,
        pinned ? 1 : 0,
        hash,
        force ? null : hash
      )
      .first<{ id: number }>();

    if (!result) {
      const concurrent = await env.DB.prepare(
        "SELECT id, content FROM memories WHERE dedupe_key = ? AND status = 'active' LIMIT 1"
      )
        .bind(hash)
        .first<{ id: number; content: string }>();
      return {
        content: [
          {
            type: "text" as const,
            text: concurrent
              ? `Exact memory was stored concurrently (id: ${concurrent.id}):\n"${concurrent.content}"`
              : "Failed to store memory.",
          },
        ],
      };
    }

    await processIndexOutbox(env, result.id, 5);
    const indexed = await env.DB.prepare("SELECT index_status FROM memories WHERE id = ?")
      .bind(result.id)
      .first<{ index_status: string }>();

    return {
      content: [
        {
          type: "text" as const,
          text: `Memory stored (id: ${result.id}, category: ${category}, importance: ${importance}, index: ${indexed?.index_status || "pending"}).${
            dupe?.kind === "related"
              ? ` Related memory ${dupe.memory.id} is ${Math.round(dupe.similarity * 100)}% similar; review it as a possible duplicate, correction, or contradiction.`
              : ""
          }`,
        },
      ],
    };
  });

  // ── update_memory ─────────────────────────────────────────────────
  server.tool("update_memory", TOOL_DESC.update, {
    id: z.number().int().positive().describe("The memory ID to update"),
    content: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CONTENT_LENGTH)
      .optional()
      .describe("New content (re-embeds automatically)"),
    category: z
      .string()
      .optional()
      .describe("New category"),
    tags: z
      .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
      .max(MAX_TAGS)
      .optional()
      .describe("New tags (replaces existing)"),
    importance: z
      .number()
      .int()
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
    const newContent = content ? validateContent(content) : existing.content;
    const newCategory = category ?? existing.category;
    const newTags =
      tags !== undefined ? JSON.stringify(normalizeTags(tags)) : existing.tags;
    const newImportance = importance ?? existing.importance;
    const newHash = await contentHash(newContent);
    if (existing.dedupe_key !== null) {
      const conflict = await env.DB.prepare(
        "SELECT id FROM memories WHERE dedupe_key = ? AND id <> ? AND status = 'active' LIMIT 1"
      )
        .bind(newHash, id)
        .first<{ id: number }>();
      if (conflict) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Update would duplicate memory ${conflict.id}.`,
            },
          ],
        };
      }
    }

    await env.DB.prepare(
      `UPDATE memories SET content = ?, category = ?, tags = ?, importance = ?,
        content_hash = ?, dedupe_key = CASE WHEN dedupe_key IS NULL THEN NULL ELSE ? END,
        record_version = record_version + 1,
        index_status = 'pending', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(newContent, newCategory, newTags, newImportance, newHash, newHash, id)
      .run();

    // Re-upsert when content OR vector metadata changed — stale category
    // metadata silently breaks category-filtered recall.
    await processIndexOutbox(env, id, 5);
    const indexed = await env.DB.prepare("SELECT index_status FROM memories WHERE id = ?")
      .bind(id)
      .first<{ index_status: string }>();

    return {
      content: [
        {
          type: "text" as const,
          text: `Memory ${id} updated (version ${existing.record_version + 1}, index: ${indexed?.index_status || "pending"}).`,
        },
      ],
    };
  });

  // ── recall ────────────────────────────────────────────────────────
  server.tool("recall", TOOL_DESC.recall, {
    query: z.string().trim().min(1).max(2_000).describe("Natural language search query"),
    category: z
      .string()
      .optional()
      .describe("Optional: filter by category"),
    limit: z
      .number()
      .int()
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

    const results = await recallMemories(env, query, category, limit);

    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length > 0
              ? JSON.stringify(results, null, 2)
              : "No memories found matching that query.",
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
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of memories to return"),
    },
    async ({ category, limit }) => {
      let query = "SELECT * FROM memories WHERE status = 'active'";
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
        query += " AND category = ?";
        binds.push(category);
      }

      query += " ORDER BY created_at DESC LIMIT ?";
      binds.push(limit);

      const { results } = await env.DB.prepare(query).bind(...binds).all();
      const formatted = (results as unknown as Memory[]).map(formatMemory);

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
      tag: z.string().trim().min(1).max(MAX_TAG_LENGTH).describe("Tag to search for"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of results"),
    },
    async ({ tag, limit }) => {
      const { results } = await env.DB.prepare(
        `SELECT * FROM memories WHERE status = 'active' AND tags LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?`
      )
        .bind(`%"${tag}"%`, limit)
        .all();

      const formatted = (results as unknown as Memory[]).map(formatMemory);

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
      id: z.number().int().positive().describe("The memory ID to delete"),
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

      await env.DB.batch([
        env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM memory_versions WHERE memory_id = ?").bind(id),
        env.DB.prepare(
          "DELETE FROM memories_archive WHERE original_id = ? OR consolidated_into = ?"
        ).bind(id, id),
      ]);
      await processIndexOutbox(env, id, 5);

      return {
        content: [
          { type: "text" as const, text: `Memory ${id} forgotten.` },
        ],
      };
    }
  );

  // ── review_stale ──────────────────────────────────────────────────
  server.tool("review_stale", TOOL_DESC.review_stale, {
    days: z
      .number()
      .int()
      .min(1)
      .default(STALE_DAYS)
      .describe("Number of days without access to consider stale"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Number of stale memories to return"),
  }, async ({ days, limit }) => {
    const results = await getStaleMemories(env, days, limit);
    const formatted = results.map(formatMemory);

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
  server.tool("memory_stats", TOOL_DESC.stats, {}, async () => {
    const stats = await getStatsData(env, categories);

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(stats, null, 2) },
      ],
    };
  });

  return server;
}

// ── Nightly Consolidation (opt-in via cron trigger) ───────────────────
async function unsafeLegacyConsolidationDisabled(env: Env) {
  const processed = new Set<string>();
  let mergeCount = 0;

  // Pinned memories (stored with force=true) are explicit "keep these
  // separate" decisions — consolidation never touches them.
  const { results: allMemories } = await env.DB.prepare(
    "SELECT id, category FROM memories WHERE pinned = 0 ORDER BY created_at DESC"
  ).all();

  if (!allMemories || allMemories.length < 2) return;

  for (const memory of allMemories as unknown as Memory[]) {
    if (processed.has(memory.id.toString())) continue;
    if (mergeCount >= MAX_CONSOLIDATION_BATCHES) break;

    // Find similar memories using the stored vector. Same-category only —
    // a health memory must never get merged into a technical one just
    // because the embeddings sit close.
    let similar;
    try {
      similar = await (env.VECTORIZE as any).queryById(memory.id.toString(), {
        topK: 5,
        returnMetadata: "all",
        filter: { category: memory.category },
      });
    } catch {
      continue;
    }

    if (!similar.matches) continue;

    // Filter for high similarity, excluding self and already-processed
    const cluster = (similar.matches as VectorizeMatch[]).filter(
      (m) =>
        m.id !== memory.id.toString() &&
        m.score >= SIMILARITY_THRESHOLD &&
        !processed.has(m.id)
    );

    if (cluster.length === 0) continue;

    // Fetch full content for cluster members (re-check pinned + category
    // in D1 — Vectorize metadata can lag)
    const clusterIds = [memory.id.toString(), ...cluster.map((c) => c.id)];
    const placeholders = clusterIds.map(() => "?").join(",");
    const { results: clusterMemories } = await env.DB.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) AND pinned = 0 AND category = ?`
    )
      .bind(...clusterIds, memory.category)
      .all();

    if (!clusterMemories || clusterMemories.length < 2) continue;

    // Merge via Workers AI
    const memoriesText = (clusterMemories as unknown as Memory[])
      .map((m) => `- ${m.content} [importance: ${m.importance}]`)
      .join("\n");

    let merged: string;
    try {
      const aiResponse = await env.AI.run(CONSOLIDATION_MODEL as any, {
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
      ...(clusterMemories as unknown as Memory[]).map((m) => m.importance)
    );
    const primaryCategory = memory.category;
    const allTags = new Set<string>();
    for (const m of clusterMemories as unknown as Memory[]) {
      for (const t of JSON.parse(m.tags || "[]")) {
        allTags.add(t);
      }
    }

    // Carry access stats forward so stale tracking survives the merge
    const maxAccessCount = Math.max(
      ...(clusterMemories as unknown as Memory[]).map((m) => m.access_count)
    );
    const lastAccessed =
      (clusterMemories as unknown as Memory[])
        .map((m) => m.last_accessed_at)
        .filter(Boolean)
        .sort()
        .pop() || null;

    // Insert consolidated memory
    const result = await env.DB.prepare(
      "INSERT INTO memories (content, category, tags, importance, source, consolidated_from, access_count, last_accessed_at) VALUES (?, ?, ?, ?, 'consolidation', ?, ?, ?) RETURNING id"
    )
      .bind(
        merged,
        primaryCategory,
        JSON.stringify([...allTags]),
        maxImportance,
        JSON.stringify((clusterMemories as unknown as Memory[]).map((m) => m.id)),
        maxAccessCount,
        lastAccessed
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

    // Archive originals before removing them — an 8B merge can drop
    // details, and without the archive that information is gone forever.
    // Only touch rows that actually passed the pinned/category re-check.
    const mergedIds = (clusterMemories as unknown as Memory[]).map((m) => m.id);
    for (const mId of mergedIds) {
      await env.DB.prepare(
        `INSERT INTO memories_archive (original_id, content, category, tags, importance, source, access_count, last_accessed_at, created_at, consolidated_into)
         SELECT id, content, category, tags, importance, source, access_count, last_accessed_at, created_at, ? FROM memories WHERE id = ?`
      )
        .bind(result.id, mId)
        .run();
      await env.DB.prepare("DELETE FROM memories WHERE id = ?")
        .bind(mId)
        .run();
      await env.VECTORIZE.deleteByIds([mId.toString()]);
    }

    // Mark as processed (including cluster members that were filtered out
    // by the re-check, so we don't re-cluster them this run)
    for (const cId of clusterIds) {
      processed.add(cId);
    }
    processed.add(result.id.toString());
    mergeCount++;
  }
}

// ── Auth Middleware ────────────────────────────────────────────────────
function checkAuth(request: Request, env: Env): Response | null {
  // Fail CLOSED: a missing secret must never mean an open server.
  if (!env.MEMORY_SECRET) {
    return jsonResp(
      {
        error:
          "Server not configured: set MEMORY_SECRET (wrangler secret put MEMORY_SECRET)",
      },
      request,
      503
    );
  }

  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  const querySecret =
    url.pathname === "/mcp" || url.pathname === "/sse"
      ? url.searchParams.get("secret")
      : null;

  const token = authHeader?.replace("Bearer ", "") || querySecret;

  if (token !== env.MEMORY_SECRET) {
    return jsonResp({ error: "Unauthorized" }, request, 401);
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
    <label>Secret</label>
    <input type="password" id="secretInput" placeholder="Your MEMORY_SECRET">
    <div class="error-msg" id="loginError"></div>
    <button class="btn btn-full" onclick="doLogin()">Connect</button>
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

function getBase(){return BASE||window.location.origin}

async function doLogin(){
  const secretInput=document.getElementById('secretInput');
  const errEl=document.getElementById('loginError');
  errEl.style.display='none';
  SECRET=secretInput.value.trim();
  if(!SECRET){errEl.textContent='Secret is required';errEl.style.display='block';return}
  BASE=window.location.origin;
  try{
    const r=await api('/api/categories');
    CATEGORIES=r.categories;
    sessionStorage.setItem('memory_base',BASE);
    sessionStorage.setItem('memory_secret',SECRET);
    showApp();
  }catch(e){errEl.textContent=e.message||'Connection failed';errEl.style.display='block'}
}

function doLogout(){
  sessionStorage.removeItem('memory_base');sessionStorage.removeItem('memory_secret');
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

// Auto-login for this browser tab only; the master secret is not persisted.
(async()=>{
  const b=sessionStorage.getItem('memory_base');
  const s=sessionStorage.getItem('memory_secret');
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
          version: VERSION,
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
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }

    // REST API
    if (url.pathname.startsWith("/api/")) {
      const authResponse = checkAuth(request, env);
      if (authResponse) return authResponse;
      const contentLength = Number(request.headers.get("Content-Length") || "0");
      if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
        return apiError("Request body exceeds 64 KiB", request, 413);
      }
      // Unhandled throws become CF 500 HTML pages with no CORS headers,
      // which browsers report as an opaque "failed to fetch".
      try {
        return await handleApi(request, env, url);
      } catch (e: any) {
        const errorId = crypto.randomUUID();
        console.error(JSON.stringify({ errorId, path: url.pathname, error: e?.message || String(e) }));
        return jsonResp(
          { error: "Internal error", error_id: errorId },
          request,
          500
        );
      }
    }

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      const authResponse = checkAuth(request, env);
      if (authResponse) return authResponse;

      const server = createServer(env);
      const handler = createMcpHandler(server as any);
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
    // v3 uses the scheduler to repair the D1 -> Vectorize projection. The old
    // destructive LLM consolidation is intentionally disabled.
    ctx.waitUntil(processIndexOutbox(env, undefined, 100).then(() => undefined));
  },
};
