<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8B5CF6,100:22D3EE&height=170&section=header&text=Memory&fontColor=ffffff&fontSize=50&fontAlignY=40&desc=Persistent%20semantic%20memory%20for%20AI,%20on%20Cloudflare&descSize=17&descAlignY=64" width="100%" />

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![MCP](https://img.shields.io/badge/MCP-server-8B5CF6?style=for-the-badge)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-Non--Commercial-A855F7?style=for-the-badge)](LICENSE)

</div>

Persistent memory for AI assistants, deployed on Cloudflare. Your AI remembers things across conversations, across platforms, everywhere.

Built on **Cloudflare Workers** + **D1** (SQLite) + **Vectorize** (semantic search) + **Workers AI** (embeddings). Exposed as an **MCP server** so any AI client that supports [Model Context Protocol](https://modelcontextprotocol.io/) can use it.

## Quick Start

```bash
npx create-memory-server
```

The installer creates the Cloudflare resources, deploys the server, and configures a supported MCP client. Review the generated resource names and secret handling before deployment.

## What It Does

Your AI gets 8 tools:

| Tool | Description |
|------|-------------|
| `store_memory` | Save a memory with category, tags, and importance. **Auto-deduplicates** — warns if a similar memory already exists. |
| `update_memory` | Update an existing memory's content, category, tags, or importance. Re-embeds automatically. |
| `recall` | Semantic search — find memories by meaning, weighted by importance. Tracks access history. |
| `list_recent` | List the most recent memories, optionally filtered by category. |
| `search_by_tag` | Find memories by tag. |
| `forget` | Delete a memory by ID (permanent). |
| `review_stale` | Find memories not accessed in N days — helps clean up outdated info. |
| `memory_stats` | Stats: totals, categories, importance distribution, stale count, most accessed. |

## Features

### Smart Deduplication

Exact duplicates are detected from a normalized SHA-256 content hash and blocked unless `force=true`. Semantic similarity is advisory rather than destructive: a correction or contradiction can be very close to the claim it replaces, so related memories are stored and reported for review.

`force=true` only permits a separate exact copy. Use `pinned=true` independently to mark a memory as protected.

### Importance Levels

Not all memories are equal. Rate memories 1-5:

- **5** — Critical (allergies, key decisions, access codes)
- **4** — Important (strong preferences, project requirements)
- **3** — Normal (general facts, moderate preferences)
- **2** — Minor (casual mentions, low-priority context)
- **1** — Trivial (throwaway context, might be useful someday)

Recall results are weighted by importance — critical memories surface first.

### Configurable Categories

Default categories:

```
people      — about people in the user's life
preference  — likes, dislikes, choices
fact        — factual info worth remembering
project     — work/project context, decisions
health      — health, allergies, conditions, meds
date        — birthdays, anniversaries, important dates
technical   — coding, tools, systems, configs
reflection  — lessons learned, insights
general     — catch-all default
```

Customize by setting `MEMORY_CATEGORIES` in `wrangler.toml` (comma-separated).

### Access Tracking

Returned recall results update `last_accessed_at` and `access_count`. This measures retrieval exposure, not confirmation or truth; use stale review as a maintenance hint rather than an automatic deletion rule.

### Repairable Vector Index

D1 is the canonical record store. Every create, update, and delete atomically writes an `index_outbox` event through database triggers. Vectorize is an asynchronous projection:

1. Mutations commit to D1 and immutable `memory_versions` first.
2. The outbox worker embeds and projects the current record version.
3. Vectors carry the D1 record version and content hash.
4. Recall rejects stale vectors and still finds pending records through lexical FTS.
5. Failed projections remain visible and retry with backoff.

Enable the scheduled reconciliation worker by uncommenting `[triggers]`:

```toml
[triggers]
crons = ["*/15 * * * *"]
```

You can also request an authenticated repair batch with `POST /api/index/reconcile` and an optional JSON body such as `{ "limit": 50 }`.

The previous automatic LLM consolidation routine is disabled. It destructively replaced active source memories and could not guarantee atomic rollback across D1 and Vectorize. Future consolidation should create reversible proposals rather than rewrite canonical history.

## Manual Setup

If you prefer to set things up manually instead of using the CLI:

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)

### 1. Clone and install

```bash
git clone https://github.com/martusha89/memory.git
cd memory
npm install
```

### 2. Create Cloudflare resources

```bash
npx wrangler login
npx wrangler d1 create memory-db
npx wrangler vectorize create memory-index --dimensions=768 --metric=cosine
```

Copy the `database_id` from the D1 output into `wrangler.toml`.

### 3. Initialize the database

```bash
npx wrangler d1 execute memory-db --remote --file=schema.sql
```

### 4. Set an auth secret

```bash
npx wrangler secret put MEMORY_SECRET
```

The secret is **required** — the server refuses all API/MCP requests (503) until it's set. It never runs open.

### 5. Deploy

```bash
npm run deploy
```

### Upgrading to v3

Back up D1, upgrade a v2.1 database to v2.2 if necessary, then apply the v3 migration:

Databases created before v2.2.0 need a one-time migration (adds the `pinned` column and the consolidation archive table):

```bash
npx wrangler d1 execute memory-db --remote --file=migrations/2026-06-12-pinned-and-archive.sql
npx wrangler d1 execute memory-db --remote --file=migrations/2026-08-21-v3-safety-foundation.sql
```

The v3 migration is a one-time migration. It adds immutable versions, projection state, an indexing outbox, and FTS. Existing rows are queued for reindexing; enable the scheduler or call the reconciliation endpoint until the backlog is clear.

### Local development

```bash
npm run db:schema:local  # Init local DB
npm run dev              # Start dev server
```

## Connecting to Claude

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-SERVER.workers.dev/mcp?secret=YOUR_SECRET"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add memory --transport sse "https://YOUR-SERVER.workers.dev/sse?secret=YOUR_SECRET"
```

### Claude Mobile / Web

Add as a remote MCP server in Claude settings:
- **URL:** `https://YOUR-SERVER.workers.dev/mcp?secret=YOUR_SECRET`
- **Transport:** Streamable HTTP

### Any MCP Client

The server exposes two MCP-compatible endpoints:
- `/mcp` — Streamable HTTP transport
- `/sse` — SSE transport

Prefer `Authorization: Bearer YOUR_SECRET`. Query-string secrets are accepted only on MCP endpoints for client compatibility; URLs can leak through logs, history, screenshots, and copied configuration. Use a dedicated strong secret and rotate it if exposed. The REST API does not accept query-string authentication.

## How It Works

```
Store/update/delete: D1 mutation
  → immutable memory_versions snapshot + index_outbox event (same D1 commit)
  → projection attempt → Vectorize(version + content hash)
  → failed attempts remain queued for repair

Recall: query → semantic candidates from Vectorize
              + lexical candidates from D1 FTS (always, not fallback-only)
              → reject stale vector versions and inactive records
              → hybrid reranking with a small importance prior
              → update access tracking only for returned results
```

The embedding model (`@cf/baai/bge-base-en-v1.5`) runs on Cloudflare's edge via Workers AI — no external API calls, no extra billing.

## Cost

On the **Cloudflare free tier** you get:

- **D1**: 5M rows read, 100K rows written per day
- **Vectorize**: 30M queried vector dimensions, 10M stored vector dimensions per month
- **Workers AI**: 10,000 neurons per day
- **Workers**: 100K requests per day

For personal use, you'll probably never hit these limits.

## License

Non-Commercial. Free to use, modify, and share for personal, educational, and non-commercial purposes. Cannot be sold or included in paid products. See [LICENSE](LICENSE) for details.
