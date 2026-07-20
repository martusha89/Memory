<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8B5CF6,100:22D3EE&height=170&section=header&text=Memory&fontColor=ffffff&fontSize=50&fontAlignY=40&desc=Persistent%20semantic%20memory%20for%20AI,%20on%20Cloudflare&descSize=17&descAlignY=64" width="100%" />

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![MCP](https://img.shields.io/badge/MCP-server-8B5CF6?style=for-the-badge)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-Non--Commercial-A855F7?style=for-the-badge)](LICENSE)

</div>

Persistent memory for AI assistants, deployed on Cloudflare. Your AI remembers things across conversations, across platforms, everywhere.

Built on **Cloudflare Workers** + **D1** (SQLite) + **Vectorize** (semantic search) + **Workers AI** (embeddings). Exposed as an **MCP server** so any AI client that supports [Model Context Protocol](https://modelcontextprotocol.io/) can use it.

## Quick Start

> **Important:** `create-memory-server@1.1.0` bundles the older v2.1 template.
> Do not use that release: if secret provisioning fails, its generated Worker
> can deploy without authentication. Until a v2.3-compatible CLI is published,
> use the manual setup below.

```bash
git clone https://github.com/martusha89/Memory.git
cd Memory
npm install
```

Then follow [Manual Setup](#manual-setup). The current server fails closed when
`MEMORY_SECRET` is absent.

## What It Does

Your AI gets 11 tools:

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
| `repair_index` | Retry failed semantic indexing and clean up stale vectors. |
| `list_archived` | Inspect original memories preserved by consolidation. |
| `restore_archived` | Restore an archived memory and rebuild its vector. |

## Features

### Smart Deduplication

When you store a memory, the server checks for semantically similar existing memories (cosine similarity > 0.85). If a near-duplicate exists, it tells you — with the option to update the existing memory instead. No more storing "user likes dark mode" twenty times.

Storing with `force=true` **pins** the memory: it marks "I know this looks similar, keep it separate", and nightly consolidation will never merge it away.

### Importance Levels

Not all memories are equal. Rate memories 1-5:

- **5** — Critical (allergies, key decisions, access codes)
- **4** — Important (strong preferences, project requirements)
- **3** — Normal (general facts, moderate preferences)
- **2** — Minor (casual mentions, low-priority context)
- **1** — Trivial (throwaway context, might be useful someday)

Recall combines Vectorize semantic matches with D1 FTS5 lexical matches, then
reranks by relevance and importance. The D1 path also provides immediate
read-after-write recall while Vectorize applies updates asynchronously.

### Self-Healing Vector Index

D1 is authoritative. Every memory records whether its Vectorize entry is
`pending`, `ready`, or `error`. Failed upserts and deletes are retried by the
nightly maintenance handler or manually with `repair_index`, so a temporary
Vectorize failure cannot silently make a memory disappear forever.

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

Every time a memory is recalled, its `last_accessed_at` timestamp and `access_count` are updated. This powers the stale memory detection and helps you understand which memories are actually useful.

### Nightly Consolidation (Opt-In)

Enable a cron job that runs nightly to:

1. **Find duplicate clusters** — memories with >85% semantic similarity, within the same category only
2. **Merge them** — uses Workers AI (Llama 3.1 8B) to intelligently combine related memories into one richer entry
3. **Archive the originals** — source memories are moved to `memories_archive` (not deleted), so nothing is ever lost if the merge drops a detail
4. **Track lineage** — merged memories store which originals they came from; pinned memories (`force=true`) are never touched
5. **Remain recoverable** — originals are visible in the web archive and can be restored

Enable by uncommenting the `[triggers]` block in `wrangler.toml`:

```toml
[triggers]
crons = ["0 2 * * *"]  # 2:00 AM UTC
```

**Free tier note:** Consolidation processes at most 5 clusters from a bounded
20-memory seed set per run. Archive/delete work is sent to D1 as transactional
batches and Vectorize deletes are batched.

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

### Upgrading from v2.1.x or earlier

Databases created before v2.2.0 need a one-time migration (adds the `pinned` column and the consolidation archive table):

```bash
npx wrangler d1 execute memory-db --remote --file=migrations/2026-06-12-pinned-and-archive.sql
```

### Upgrading from v2.2.x

Apply the v2.3 reliability migration before deploying the new Worker:

```bash
npm run db:migrate:hardening
```

The migration adds FTS5 search, vector repair state, recoverable consolidation
metadata, and maintenance locks. Take a D1 backup before any production schema
migration.

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
          "args": [
            "-y", "mcp-remote",
            "https://YOUR-SERVER.workers.dev/mcp",
            "--header", "Authorization: Bearer ${MEMORY_SECRET}"
          ],
          "env": {
            "MEMORY_SECRET": "YOUR_SECRET"
          }
    }
  }
}
```

### Claude Code

```bash
claude mcp add memory --transport http \
  --header "Authorization: Bearer YOUR_SECRET" \
  "https://YOUR-SERVER.workers.dev/mcp"
```

### Claude Mobile / Web

Add as a remote MCP server in Claude settings:
- **URL:** `https://YOUR-SERVER.workers.dev/mcp`
- **Transport:** Streamable HTTP
- **Authorization:** `Bearer YOUR_SECRET`

### Any MCP Client

The server exposes two MCP-compatible endpoints:
- `/mcp` — Streamable HTTP transport
- `/sse` — SSE transport

Authenticate with `Authorization: Bearer YOUR_SECRET`. Query-string secrets are
disabled by default because URLs are commonly retained in history and logs. If
a legacy MCP client cannot send headers, set `ALLOW_QUERY_AUTH = "true"` in
`wrangler.toml` and use `?secret=...` only as a compatibility fallback.

Cross-origin browser access is denied by default. Set
`MEMORY_ALLOWED_ORIGINS` to a comma-separated list of exact trusted origins if
you host the UI separately.

## How It Works

```
Store: content → D1 (full record) + AI embed → Vectorize (vector)
         ↘ dedup check: Vectorize query (>0.85 = similar exists)

Recall: query → AI embed → Vectorize candidates ┐
              → D1 FTS5 lexical candidates ─────┼→ hybrid rerank → top-K
                                                └→ update access tracking

Consolidation (nightly, opt-in):
  for each unpinned memory → Vectorize queryById (same-category clusters)
  → Workers AI merges cluster → index replacement → transactional D1 archive/delete
  → batched vector cleanup; failures recorded for retry
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
