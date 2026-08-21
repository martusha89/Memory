import { describe, expect, it } from "vitest";
import {
  contentHash,
  normalizeContent,
  normalizeTags,
  positiveInt,
  isProjectionCurrent,
  scoreRecallCandidate,
  validateContent,
  validateQuery,
} from "./memory-core";

describe("content identity", () => {
  it("normalizes case, Unicode width, and whitespace before hashing", async () => {
    expect(normalizeContent("  Marta\tLIKES  dark mode  ")).toBe("marta likes dark mode");
    await expect(contentHash("Marta likes dark mode")).resolves.toBe(
      await contentHash("  MARTA   likes dark mode ")
    );
  });

  it("keeps contradictory content distinct", async () => {
    expect(await contentHash("Sam takes medication X")).not.toBe(
      await contentHash("Sam stopped taking medication X")
    );
  });
});

describe("truth-safe retrieval primitives", () => {
  it("rejects vectors created from an older record version or content hash", () => {
    const memory = { record_version: 2, indexed_version: 2, content_hash: "new" };
    expect(
      isProjectionCurrent(memory, { record_version: 1, content_hash: "old" })
    ).toBe(false);
    expect(
      isProjectionCurrent(memory, { record_version: 2, content_hash: "new" })
    ).toBe(true);
  });

  it("does not let maximum importance overpower materially better relevance", () => {
    const weakButImportant = scoreRecallCandidate(0.56, 0, 5);
    const strongButTrivial = scoreRecallCandidate(0.82, 0, 1);
    expect(strongButTrivial).toBeGreaterThan(weakButImportant);
  });
});

describe("input validation", () => {
  it("normalizes and deduplicates tags", () => {
    expect(normalizeTags([" Project ", "project", "Memory"])).toEqual([
      "project",
      "memory",
    ]);
  });

  it("rejects malformed or unbounded values", () => {
    expect(() => normalizeTags(["x".repeat(65)])).toThrow();
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow();
    expect(() => validateContent("   ")).toThrow();
    expect(() => validateQuery("x".repeat(2_001))).toThrow();
  });

  it("accepts only positive integer limits", () => {
    expect(positiveInt(undefined, 10, 20)).toBe(10);
    expect(positiveInt(100, 10, 20)).toBe(20);
    expect(() => positiveInt(-1, 10, 20)).toThrow();
    expect(() => positiveInt(1.5, 10, 20)).toThrow();
  });
});
