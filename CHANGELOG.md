# Changelog

## 2.3.0 - 2026-07-20

### Security

- Validate every REST write and recall request with bounded Zod schemas.
- Remove inline event handlers, escape stored metadata, and enforce a nonce
  Content Security Policy in the embedded UI.
- Keep browser secrets in session storage unless the user explicitly chooses
  to remember them.
- Deny cross-origin requests and query-string authentication by default.
- Stop returning raw internal exception messages to API clients.

### Reliability

- Add D1 FTS5 lexical retrieval and hybrid reranking for immediate
  read-after-write recall.
- Track vector indexing state and retry failed upserts/deletes.
- Keep D1 writes available when embedding or semantic deduplication is
  temporarily unavailable; failed indexing remains queued for repair.
- Make consolidation bounded, locked, logged, and transactionally archive its
  source rows before batched vector cleanup.
- Reserve consolidation sources so concurrent edits or deletes abort safely,
  and keep the replacement active after the archive transaction commits.
- Add archive listing and idempotent restore through REST, MCP, and the web UI.
- Enforce archive-restore idempotency with an active-row uniqueness claim.
- Add deep authenticated health data and exact JSON tag matching.
- Mark pre-v2.3 rows pending so operators can verify and refresh existing
  Vectorize entries in bounded batches.
- Recheck semantic candidates against authoritative D1 category/vector state,
  bound LIKE fallbacks, and rotate retry timestamps to prevent starvation.
- Serialize indexing with per-memory leases and generations so stale embeddings
  cannot win races with edits or deletes.
- Reject stale read-modify-write updates and keep consolidation replacements
  owned until their source archive transaction commits.

### Tooling

- Add tests, type checking, dependency auditing, CI, and Dependabot.
- Move Wrangler to development dependencies and refresh dependencies to an
  audit-clean lockfile.
- Warn against the outdated `create-memory-server@1.1.0` installer until a
  matching CLI release is published.
- Update the generated setup guide to require authentication, use Bearer
  headers, test `/health`, and avoid incomplete fallback schemas.
- Advertise only the working Streamable HTTP endpoint and allow the standard
  MCP CORS request/session headers.
