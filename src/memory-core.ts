export const MAX_CONTENT_LENGTH = 20_000;
export const MAX_QUERY_LENGTH = 2_000;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 64;

export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").normalize("NFKC").toLowerCase();
}

export async function contentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeContent(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new Error("tags must be an array of strings");
  const normalized = tags.map((tag) => {
    if (typeof tag !== "string") throw new Error("tags must contain only strings");
    const clean = tag.trim().toLowerCase();
    if (!clean || clean.length > MAX_TAG_LENGTH) {
      throw new Error(`tags must be 1-${MAX_TAG_LENGTH} characters`);
    }
    return clean;
  });
  if (normalized.length > MAX_TAGS) throw new Error(`no more than ${MAX_TAGS} tags are allowed`);
  return [...new Set(normalized)];
}

export function validateContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("content must be a string");
  const content = value.trim();
  if (!content) throw new Error("content is required");
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content must be at most ${MAX_CONTENT_LENGTH} characters`);
  }
  return content;
}

export function validateQuery(value: unknown): string {
  if (typeof value !== "string") throw new Error("query must be a string");
  const query = value.trim();
  if (!query) throw new Error("query is required");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return query;
}

export function positiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("value must be a positive integer");
  }
  return Math.min(value, max);
}

export interface ProjectionIdentity {
  record_version: number;
  content_hash: string;
  indexed_version: number | null;
}

export function isProjectionCurrent(
  memory: ProjectionIdentity,
  metadata: Record<string, unknown>
): boolean {
  return (
    metadata.record_version === memory.record_version &&
    metadata.content_hash === memory.content_hash &&
    memory.indexed_version === memory.record_version
  );
}

export function scoreRecallCandidate(
  semanticScore: number,
  lexicalScore: number,
  importance: number
): number {
  const relevance = Math.max(semanticScore, lexicalScore * 0.92);
  const corroboration = semanticScore > 0 && lexicalScore > 0 ? 0.03 : 0;
  const importancePrior = (Math.min(Math.max(importance, 1), 5) / 5) * 0.05;
  return Math.min(relevance + corroboration + importancePrior, 1);
}
