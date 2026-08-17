import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReviewerRegistryEntry } from "../../coordination/types";
import { PLAN_MARKDOWN_NORMALIZATION_VERSION } from "../../coordination/planning";
import {
  derivePlanWriterState,
  MAX_PLAN_PUBLICATION_BYTES,
  normalizeCanonicalPlanForDigest,
  normalizeObservedPlanMarkdown,
  normalizeObservedPlanPublication,
  planWriterTerminalId,
  sha256Hex,
} from "../plan-writer-contract";

const normalizationContract = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../configs/plan-markdown-normalization-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  version: number;
  cases: Array<{ name: string; input: string; canonical: string }>;
};

describe("Plan Writer publication contract", () => {
  it("matches the shared plan Markdown normalization contract", () => {
    expect(normalizationContract.version).toBe(
      PLAN_MARKDOWN_NORMALIZATION_VERSION,
    );
    for (const fixture of normalizationContract.cases) {
      expect(normalizeCanonicalPlanForDigest(fixture.input), fixture.name).toBe(
        fixture.canonical,
      );
    }
  });

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

  it.each([
    [undefined, "reserving"],
    [{ jobSlug: "plan-writer-1", generation: 1 }, "launching"],
  ] as const)("exposes honest %s startup progress", (runtime, stage) => {
    const writer: ReviewerRegistryEntry = {
      threadId: "plan-writer-plan-1",
      planArtifactId: "plan-1",
      repoId: "repo-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      role: "writer",
      status: "queued",
      reviewerModel: "gpt-5.6-sol",
      generation: 1,
      basisCommit: "main-1",
      createdAt: "2026-08-13T19:59:00.000Z",
      updatedAt: "2026-08-13T20:00:00.000Z",
      ...(runtime ? { runtime, jobSlug: runtime.jobSlug } : {}),
    };

    expect(derivePlanWriterState(writer, true)).toMatchObject({
      lifecycle: "starting",
      startup: {
        stage,
        updatedAt: writer.updatedAt,
      },
    });
  });
});
