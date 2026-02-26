# Memory

Persistent memory for AI assistants, deployed on Cloudflare. Your AI remembers things across conversations, across platforms, everywhere.

Built on **Cloudflare Workers** + **D1** (SQLite) + **Vectorize** (semantic search) + **Workers AI** (embeddings). Exposed as an **MCP server** so any AI client that supports [Model Context Protocol](https://modelcontextprotocol.io/) can use it.

## What It Does

Your AI gets 6 tools:

| Tool | Description |
|------|-------------|
| `store_memory` | Save a memory with optional category and tags |
| `recall` | Semantic search — find memories by meaning, not just keywords |
| `list_recent` | List the most recent memories |
| `search_by_tag` | Find memories by tag |
| `forget` | Delete a memory by ID |
| `memory_stats` | Get stats (total count, breakdown by category/source) |

When a memory is stored, it gets embedded into a vector and saved to both D1 (full text) and Vectorize (semantic search). When your AI recalls something, it searches by meaning first, with a keyword fallback.

## Setup

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

Log in to Cloudflare:

```bash
npx wrangler login
```

Create a D1 database:

```bash
npx wrangler d1 create memory-db
```

This will output a `database_id`. Copy it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "memory-db"
database_id = "paste-your-id-here"
```

Create a Vectorize index:

```bash
npx wrangler vectorize create memory-index --dimensions=768 --metric=cosine
```

> The dimensions must be **768** — that's what the BGE-base-en-v1.5 embedding model outputs.

### 3. Initialize the database

```bash
npx wrangler d1 execute memory-db --remote --file=schema.sql
```

### 4. (Optional) Set an auth secret

```bash
npx wrangler secret put MEMORY_SECRET
```

If you skip this, the server runs without auth (fine for local dev, not recommended for production).

### 5. Deploy

```bash
npm run deploy
```

Your memory server is now live at `https://memory-server.<your-subdomain>.workers.dev`.

### Local development

```bash
npm run dev
```

For local D1, initialize the schema first:

```bash
npm run db:schema:local
```

## Connecting to Your AI

### Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "memory": {
      "url": "https://memory-server.YOUR-SUBDOMAIN.workers.dev/sse?secret=YOUR_SECRET"
    }
  }
}
```

### Claude Code

```bash
claude mcp add memory --transport sse "https://memory-server.YOUR-SUBDOMAIN.workers.dev/sse?secret=YOUR_SECRET"
```

### Any MCP Client

The server exposes two MCP-compatible endpoints:
- `/mcp` — Streamable HTTP transport
- `/sse` — SSE transport

Auth via `Authorization: Bearer YOUR_SECRET` header or `?secret=YOUR_SECRET` query parameter.

## Categories

Memories are organized into categories:

- `general` — Default catch-all
- `personal` — About the user
- `preference` — User preferences and choices
- `emotional` — Emotional context and state
- `technical` — Technical knowledge and decisions
- `reflection` — Insights and lessons learned
- `fact` — Factual information
- `conversation` — Conversation context worth remembering

You can customize these by editing the `CATEGORIES` array in `src/index.ts`.

## How It Works

```
Store: content → D1 (full record) + AI embed → Vectorize (vector)
Recall: query → AI embed → Vectorize (top-K nearest) → D1 (full records)
                         ↘ fallback: D1 keyword LIKE search
```

The embedding model (`@cf/baai/bge-base-en-v1.5`) runs on Cloudflare's edge via Workers AI — no external API calls, no extra billing. D1 and Vectorize are included in Cloudflare's free tier.

## Cost

On the **Cloudflare free tier** you get:
- **D1**: 5M rows read, 100K rows written per day
- **Vectorize**: 30M queried vector dimensions, 10M stored vector dimensions per month
- **Workers AI**: 10,000 neurons per day
- **Workers**: 100K requests per day

For personal use, you'll probably never hit these limits.

## License

MIT
