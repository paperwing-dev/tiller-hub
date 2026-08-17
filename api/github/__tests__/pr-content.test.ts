import { describe, expect, it } from "vitest";
import {
  buildDraftPrContent,
  buildManagedPrSection,
  upsertManagedPrSection,
} from "../pr-content";

describe("draft PR content", () => {
  it("uses the complete startup plan as the PR content", () => {
    const planMarkdown = [
      "# Improve draft PR descriptions",
      "",
      "## Summary",
      "",
      "Generate **useful** pull request titles and explain the user-facing change.",
      "",
      "## Implementation",
      "",
      "Preserve these internal details in the PR plan.",
    ].join("\n");
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Implementation Plan: Improve draft PR descriptions",
      planMarkdown,
      changedFiles: [
        {
          path: "/packages/hub/api/github/env-publish-service.ts",
          status: "modified",
        },
        { path: "/packages/hub/api/github/pr-content.ts", status: "added" },
      ],
    });

    expect(content.title).toBe("Improve draft PR descriptions");
    expect(content.featureMarkdown).toBe(planMarkdown);
    expect(content.featureMarkdown).not.toContain("2 files changed");
  });

  it("uses a meaningful plan heading when the artifact title is generic", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Draft",
      planMarkdown:
        "```md\n# Ignore fenced heading\n```\n\n# Improve GitHub publishing\n\n## Summary\n\nDescribe published changes.",
      changedFiles: [{ path: "src/publish.ts", status: "modified" }],
    });

    expect(content.title).toBe("Improve GitHub publishing");
  });

  it("falls back to a descriptive implementation path and ignores support files", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      changedFiles: [
        { path: "package.json", status: "modified" },
        {
          path: "packages/hub/api/github/__tests__/publish.test.ts",
          status: "modified",
        },
        { path: "packages/hub/api/github/publish.ts", status: "added" },
      ],
    });

    expect(content.title).toBe("Add packages/hub/api/github/publish.ts");
  });

  it("falls back to the generated summary when there is no plan", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Improve draft PR descriptions",
      changedFiles: [
        { path: "packages/hub/api/github/new-content.ts", status: "added" },
        { path: "packages/hub/api/github/pr-content.ts", status: "modified" },
        { path: "packages/hub/api/github/old-content.ts", status: "deleted" },
      ],
    });
    const section = buildManagedPrSection({
      content,
      envSlug: "tiller",
      baseCommitSha: "base-sha",
      branchHeadSha: "head-sha",
      workspaceHash: "workspace-hash",
      defaultBranch: "main",
      updatedAt: "2026-07-09T18:05:27.070Z",
    });

    expect(section).toContain(
      "3 files changed (1 added, 1 modified, 1 deleted).",
    );
    expect(section).toContain("## Summary\n\nImprove draft PR descriptions.");
    expect(section).toContain(
      "- Added `packages/hub/api/github/new-content.ts`",
    );
    expect(section).toContain(
      "- Modified `packages/hub/api/github/pr-content.ts`",
    );
    expect(section).toContain(
      "- Deleted `packages/hub/api/github/old-content.ts`",
    );
    expect(section).toContain("<summary>Tiller publish details</summary>");
    expect(section.indexOf("## Summary")).toBeLessThan(
      section.indexOf("Workspace hash"),
    );
  });

  it("preserves fenced content in a plan", () => {
    const planMarkdown = [
      "## Summary",
      "",
      "Explain this example:",
      "```ts",
      "# heading-looking content",
      "```",
    ].join("\n");
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Render safe summaries",
      planMarkdown,
      changedFiles: [{ path: "src/summary.ts", status: "modified" }],
    });

    expect(content.featureMarkdown).toBe(planMarkdown);
    expect(content.featureMarkdown).toContain("```ts");
    expect(content.featureMarkdown).not.toContain("## Changes");
  });

  it("does not reduce a plan to its Summary section", () => {
    const planMarkdown = [
      "```md",
      "## Summary",
      "This is example content.",
      "```",
      "",
      "## Summary",
      "",
      "This is the feature summary.",
      "",
      "## Implementation",
      "",
      "These implementation details are part of the plan.",
    ].join("\n");
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Describe the actual feature",
      planMarkdown,
      changedFiles: [{ path: "src/summary.ts", status: "modified" }],
    });

    expect(content.featureMarkdown).toBe(planMarkdown);
    expect(content.featureMarkdown).toContain("## Implementation");
    expect(content.featureMarkdown).toContain(
      "These implementation details are part of the plan.",
    );
  });

  it("updates the current managed section while preserving surrounding text", () => {
    const existing = [
      "Reviewer note: keep this context.",
      "",
      "<!-- tiller:env-draft:v2:start -->",
      "Old generated content.",
      "<!-- tiller:env-draft:v2:end -->",
      "",
      "Footer written on GitHub.",
    ].join("\n");
    const nextSection =
      "<!-- tiller:env-draft:v2:start -->\n## Summary\n\nNew details.\n<!-- tiller:env-draft:v2:end -->";

    const updated = upsertManagedPrSection(existing, nextSection);

    expect(updated).toContain("Reviewer note: keep this context.");
    expect(updated).toContain("Footer written on GitHub.");
    expect(updated).toContain("New details.");
    expect(updated).not.toContain("Old generated content.");
  });

  it("updates a managed plan that mentions the section marker", () => {
    const existing = [
      "<!-- tiller:env-draft:v2:start -->",
      "# Plan",
      "",
      "Keep `<!-- tiller:env-draft:v2:end -->` safe in examples.",
      "<!-- tiller:env-draft:v2:end -->",
    ].join("\n");
    const nextSection =
      "<!-- tiller:env-draft:v2:start -->\n# Updated plan\n<!-- tiller:env-draft:v2:end -->";

    expect(upsertManagedPrSection(existing, nextSection)).toBe(nextSection);
  });
});
