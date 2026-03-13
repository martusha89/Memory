# Memory

Persistent memory for AI assistants, deployed on Cloudflare. Your AI remembers things across conversations, across platforms, everywhere.

Built on **Cloudflare Workers** + **D1** (SQLite) + **Vectorize** (semantic search) + **Workers AI** (embeddings). Exposed as an **MCP server** so any AI client that supports [Model Context Protocol](https://modelcontextprotocol.io/) can use it.

## Quick Start

```bash
npx create-memory-server
```

That's it. The CLI walks you through everything — creates your Cloudflare resources, deploys the server, and configures Claude. Done in 2 minutes.

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

When you store a memory, the server checks for semantically similar existing memories (cosine similarity > 0.85). If a near-duplicate exists, it tells you — with the option to update the existing memory instead. No more storing "user likes dark mode" twenty times.

### Importance Levels

Not all memories are equal. Rate memories 1-5:

- **5** — Critical (allergies, key decisions, access codes)
- **4** — Important (strong preferences, project requirements)
- **3** — Normal (general facts, moderate preferences)
- **2** — Minor (casual mentions, low-priority context)
- **1** — Trivial (throwaway context, might be useful someday)

Recall results are weighted by importance — critical memories surface first.

### Behavior Modes

Control how proactively Claude uses memory via the `MEMORY_BEHAVIOR` setting:

| Mode | Description |
|------|-------------|
| `proactive` | Recall at session start, store new info automatically. **(default)** |
| `balanced` | Recall when relevant, store key facts. |
| `manual` | Only store/recall when explicitly asked. |

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

1. **Find duplicate clusters** — memories with >85% semantic similarity
2. **Merge them** — uses Workers AI (Llama 3.1 8B) to intelligently combine related memories into one richer entry
3. **Track lineage** — merged memories store which originals they came from

Enable by uncommenting the `[triggers]` block in `wrangler.toml`:

```toml
[triggers]
crons = ["0 2 * * *"]  # 2:00 AM UTC
```

**Free tier note:** The consolidation uses Workers AI (10,000 neurons/day free) and is subject to the 50-subrequest limit on the free Workers plan. It processes up to 20 clusters per run and catches up over multiple nights if needed.

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

### 5. Deploy

```bash
npm run deploy
```

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

Auth via `Authorization: Bearer YOUR_SECRET` header or `?secret=YOUR_SECRET` query parameter.

## How It Works

```
Store: content → D1 (full record) + AI embed → Vectorize (vector)
         ↘ dedup check: Vectorize query (>0.85 = similar exists)

Recall: query → AI embed → Vectorize (top-K, importance-weighted)
                         → D1 (full records) + update access tracking
                         ↘ fallback: D1 keyword LIKE search

Consolidation (nightly, opt-in):
  for each memory → Vectorize queryById (find clusters)
  → Workers AI merges cluster → replace with consolidated memory
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
