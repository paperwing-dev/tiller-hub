import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_PUBLICATION_BYTES,
  normalizeCanonicalPlanForDigest,
  normalizeObservedPlanMarkdown,
  normalizeObservedPlanPublication,
  planWriterTerminalId,
  sha256Hex,
} from "../plan-writer-contract";

describe("Plan Writer publication contract", () => {
  it("normalizes only line endings and terminal blank lines", () => {
    expect(normalizeObservedPlanMarkdown("# Plan\r\n\r\nBody  \r\n\r\n"))
      .toBe("# Plan\n\nBody  \n");
    expect(normalizeCanonicalPlanForDigest("\r\n\r\n")).toBe("");
    expect(() => normalizeObservedPlanMarkdown(" \n\t\n")).toThrow(/empty/i);
  });

  it("measures the one MiB limit as UTF-8 bytes", () => {
    const within = "a".repeat(MAX_PLAN_PUBLICATION_BYTES - 1);
    expect(normalizeObservedPlanMarkdown(within)).toHaveLength(MAX_PLAN_PUBLICATION_BYTES);
    expect(() => normalizeObservedPlanMarkdown(`é${"a".repeat(MAX_PLAN_PUBLICATION_BYTES - 2)}`))
      .toThrow(/exceeds/i);
  });

  it("validates digests, sequences, and bounded provider identifiers", async () => {
    const markdown = "# Plan\n";
    await expect(normalizeObservedPlanPublication({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      generation: 1,
      providerConversationId: "conversation-1",
      sequence: 1,
      providerEventId: "event-1",
      markdown,
      bodyDigest: await sha256Hex(markdown),
    })).resolves.toMatchObject({ markdown, sequence: 1 });
    await expect(normalizeObservedPlanPublication({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      generation: 1,
      providerConversationId: "conversation-1",
      sequence: 2,
      providerEventId: "event-2",
      markdown,
      bodyDigest: "0".repeat(64),
    })).rejects.toThrow(/digest/i);
  });

  it("derives a stable bounded terminal identity solely from repo, plan, and generation", () => {
    const first = planWriterTerminalId("repo-with-a-long-name", "plan-with-a-long-name", 7);
    expect(first).toBe(planWriterTerminalId("repo-with-a-long-name", "plan-with-a-long-name", 7));
    expect(first).not.toBe(planWriterTerminalId("repo-with-a-long-name", "plan-with-a-long-name", 8));
    expect(first.length).toBeLessThan(80);
  });
});
