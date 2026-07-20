import { z } from "zod";

export const MAX_CONTENT_LENGTH = 20_000;
export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 64;

const DEFAULT_CATEGORIES = [
  "people", "preference", "fact", "project", "health", "date",
  "technical", "reflection", "general",
] as const;

export const SOURCES = [
  "claude_code", "claude_desktop", "claude_web", "claude_mobile",
  "api", "web", "import", "restore", "consolidation", "unknown",
] as const;

const sourceSchema = z.enum(SOURCES);
export const tagsValueSchema = z
  .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_TAGS);
export const tagsSchema = tagsValueSchema.default([]);
export const contentSchema = z.string().trim().min(1).max(MAX_CONTENT_LENGTH);
export const importanceValueSchema = z.number().int().min(1).max(5);
export const importanceSchema = importanceValueSchema.default(3);

export const createMemorySchema = z.object({
  content: contentSchema,
  category: z.string().trim().min(1).default("general"),
  tags: tagsSchema,
  importance: importanceSchema,
  source: sourceSchema.default("api"),
  force: z.boolean().default(false),
});

export const updateMemorySchema = z
  .object({
    content: contentSchema.optional(),
    category: z.string().trim().min(1).optional(),
    tags: tagsValueSchema.optional(),
    importance: importanceValueSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export const recallSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  category: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(20).default(10),
});

export function getCategories(env: { MEMORY_CATEGORIES?: string }): string[] {
  if (env.MEMORY_CATEGORIES) {
    const configured = env.MEMORY_CATEGORIES.split(",")
      .map((category) => category.trim().toLowerCase())
      .filter((category) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(category));
    if (configured.length > 0) return [...new Set(configured)];
  }
  return [...DEFAULT_CATEGORIES];
}

export async function hashContent(content: string): Promise<string> {
  const normalized = content.trim().replace(/\s+/g, " ").toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function safeStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .slice(0, MAX_TAGS)
          .map((item) => item.slice(0, MAX_TAG_LENGTH))
      : [];
  } catch {
    return [];
  }
}

export function safeNumberArray(value: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is number => Number.isInteger(item))
          .slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

export function ftsQuery(input: string): string | null {
  const tokens = input
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 12);
  if (!tokens?.length) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export function likePattern(input: string): string | null {
  const encoder = new TextEncoder();
  let escaped = "";
  for (const character of input.trim()) {
    const next = escaped + (/[\\%_]/.test(character) ? `\\${character}` : character);
    if (encoder.encode(`%${next}%`).length > 50) break;
    escaped = next;
  }
  return escaped ? `%${escaped}%` : null;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
