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
- Make consolidation bounded, locked, logged, and transactionally archive its
  source rows before batched vector cleanup.
- Add archive listing and idempotent restore through REST, MCP, and the web UI.
- Add deep authenticated health data and exact JSON tag matching.

### Tooling

- Add tests, type checking, dependency auditing, CI, and Dependabot.
- Move Wrangler to development dependencies and refresh dependencies to an
  audit-clean lockfile.
- Warn against the outdated `create-memory-server@1.1.0` installer until a
  matching CLI release is published.
