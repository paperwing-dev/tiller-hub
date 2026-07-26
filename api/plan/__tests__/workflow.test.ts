import { describe, expect, it } from "vitest";
import type { PlanArtifact } from "../../coordination";
import {
  PLAN_DEFAULT_MODEL,
  buildPlanIntegrationPrompt,
  filterPlanReviewIssues,
  parsePlanIntegrationResponse,
  parsePlanReviewResponse,
  resolvePlanModel,
  summarizeFilteredReview,
} from "../workflow";

const draft: PlanArtifact = {
  id: "draft-1",
  repoId: "repo-1",
  type: "plan",
  basis: {
    repoId: "repo-1",
    mainCommit: "abc123",
  },
  title: "Plan tests for tiller",
  body: {
    markdown: [
      "1. Harness and workspace integration",
      "- Add package scripts in /packages/tiller/package.json.",
      "2. Batch 1 — config and auth tests",
      "- Test loadConfig() returns {} on malformed JSON.",
      "3. Batch 2 — HubClient unit tests with isolated WebSocket/timers",
    ].join("\n"),
  },
  createdBy: "plan",
  createdAt: "2026-03-28T00:00:00.000Z",
};

describe("resolvePlanModel", () => {
  it("defaults to ChatGPT 5.5 when the selection is invalid", () => {
    expect(resolvePlanModel("not-a-real-model")).toBe(PLAN_DEFAULT_MODEL);
    expect(resolvePlanModel(undefined)).toBe(PLAN_DEFAULT_MODEL);
  });

  it("returns supported planner models unchanged", () => {
    expect(resolvePlanModel("gpt-5.5")).toBe("gpt-5.5");
    expect(resolvePlanModel("@cf/nvidia/nemotron-3-120b-a12b")).toBe(
      "@cf/nvidia/nemotron-3-120b-a12b",
    );
    expect(resolvePlanModel("@cf/moonshotai/kimi-k2.7-code")).toBe(
      "@cf/moonshotai/kimi-k2.7-code",
    );
  });
});

describe("parsePlanReviewResponse", () => {
  it("parses JSON review payloads wrapped in markdown fences", () => {
    const parsed = parsePlanReviewResponse(`
\`\`\`json
{
  "summary": "Found one real issue",
  "issues": [
    {
      "issue": "Script validation is missing",
      "evidenceQuote": "Add package scripts in /packages/tiller/package.json.",
      "recommendedChange": "Add an explicit root-workspace validation step."
    }
  ]
}
\`\`\`
`);

    expect(parsed).toEqual({
      summary: "Found one real issue",
      issues: [
        {
          issue: "Script validation is missing",
          evidenceQuote: "Add package scripts in /packages/tiller/package.json.",
          recommendedChange: "Add an explicit root-workspace validation step.",
        },
      ],
    });
  });
});

describe("filterPlanReviewIssues", () => {
  it("keeps only grounded, non-duplicate issues with real evidence and changes", () => {
    const filtered = filterPlanReviewIssues({
      draft,
      sourceReviewId: "review-1",
      sourceModel: "@cf/nvidia/nemotron-3-120b-a12b",
      issues: [
        {
          issue: "Script validation is missing",
          evidenceQuote: "Add package scripts in /packages/tiller/package.json.",
          recommendedChange: "Add a root-workspace script validation step.",
        },
        {
          issue: "This restates itself",
          evidenceQuote: "This restates itself",
          recommendedChange: "This restates itself",
        },
        {
          issue: "Missing change",
          evidenceQuote: "Test loadConfig() returns {} on malformed JSON.",
          recommendedChange: "",
        },
        {
          issue: "Script validation is missing",
          evidenceQuote: "Add package scripts in /packages/tiller/package.json.",
          recommendedChange: "Add a root-workspace script validation step.",
        },
      ],
    });

    expect(filtered.kept).toHaveLength(1);
    expect(filtered.kept[0]).toMatchObject({
      sourceReviewId: "review-1",
      issue: "Script validation is missing",
    });
    expect(filtered.stats).toEqual({
      total: 4,
      kept: 1,
      dropped: 3,
    });
  });

  it("summarizes filtered reviews using grounded counts", () => {
    const filtered = filterPlanReviewIssues({
      draft,
      sourceReviewId: "review-1",
      issues: [
        {
          issue: "Script validation is missing",
          evidenceQuote: "Add package scripts in /packages/tiller/package.json.",
          recommendedChange: "Add a root-workspace script validation step.",
        },
      ],
    });

    expect(
      summarizeFilteredReview({
        parsedSummary: "Original summary",
        filtered,
      }),
    ).toBe("1 grounded issue kept. Script validation is missing");
  });
});

describe("integration helpers", () => {
  it("builds an integration prompt with inline draft and filtered issues", () => {
    const prompt = buildPlanIntegrationPrompt({
      draft,
      selectedModel: "gpt-5.5",
      filteredIssues: [
        {
          sourceReviewId: "review-1",
          sourceModel: "@cf/nvidia/nemotron-3-120b-a12b",
          issue: "Script validation is missing",
          evidenceQuote: "Add package scripts in /packages/tiller/package.json.",
          recommendedChange: "Add a root-workspace script validation step.",
        },
      ],
    });

    expect(prompt).toContain("Current draft plan:");
    expect(prompt).toContain("Filtered review issues:");
    expect(prompt).toContain("sourceReviewId: review-1");
    expect(prompt).toContain("Add package scripts in /packages/tiller/package.json.");
  });

  it("parses planner integration JSON payloads", () => {
    const parsed = parsePlanIntegrationResponse(`
{
  "accepted": [
    {
      "sourceReviewId": "review-1",
      "issue": "Script validation is missing",
      "change": "Added a root-workspace script validation step."
    }
  ],
  "rejected": [],
  "updatedSummary": "Added root-workspace validation.",
  "revisedPlan": "1. Updated plan"
}
`);

    expect(parsed).toEqual({
      accepted: [
        {
          sourceReviewId: "review-1",
          issue: "Script validation is missing",
          change: "Added a root-workspace script validation step.",
        },
      ],
      rejected: [],
      updatedSummary: "Added root-workspace validation.",
      revisedPlan: "1. Updated plan",
    });
  });
});
