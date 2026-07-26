import { describe, expect, it } from "vitest";
import {
  buildDraftPrContent,
  buildManagedPrSection,
  upsertManagedPrSection,
} from "../pr-content";

describe("draft PR content", () => {
  it("uses startup plan feature context for the title and plain-text summary", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Implementation Plan: Improve draft PR descriptions",
      planMarkdown: [
        "# Improve draft PR descriptions",
        "",
        "## Summary",
        "",
        "Generate **useful** pull request titles and explain the user-facing change.",
        "",
        "## Implementation",
        "",
        "Internal details that should not become the PR summary.",
      ].join("\n"),
      changedFiles: [
        {
          path: "/packages/hub/api/github/env-publish-service.ts",
          status: "modified",
        },
        { path: "/packages/hub/api/github/pr-content.ts", status: "added" },
      ],
    });

    expect(content.title).toBe("Improve draft PR descriptions");
    expect(content.featureMarkdown).toContain(
      "## Summary\n\nGenerate useful pull request titles and explain the user-facing change.",
    );
    expect(content.featureMarkdown).toContain(
      "2 files changed (1 added, 1 modified).",
    );
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

  it("renders accurate file statuses and keeps metadata secondary", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Improve draft PR descriptions",
      planMarkdown: "## Goal\n\nDescribe the feature and changed files.",
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

  it("turns fenced plan content into safe plain text", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Render safe summaries",
      planMarkdown: [
        "## Summary",
        "",
        "Explain this example:",
        "```ts",
        "# heading-looking content",
        "```",
      ].join("\n"),
      changedFiles: [{ path: "src/summary.ts", status: "modified" }],
    });

    expect(content.featureMarkdown).not.toContain("```");
    expect(content.featureMarkdown).toContain("## Changes");
  });

  it("ignores heading-looking lines inside fences when selecting the summary", () => {
    const content = buildDraftPrContent({
      envSlug: "tiller",
      planTitle: "Describe the actual feature",
      planMarkdown: [
        "```md",
        "## Summary",
        "This is example content, not the feature summary.",
        "```",
        "",
        "## Summary",
        "",
        "This is the actual feature summary.",
        "",
        "```md",
        "## Example heading",
        "```",
        "",
        "This is still part of the feature summary.",
        "",
        "## Implementation",
        "",
        "Internal details.",
      ].join("\n"),
      changedFiles: [{ path: "src/summary.ts", status: "modified" }],
    });

    expect(content.featureMarkdown).toContain(
      "This is the actual feature summary.",
    );
    expect(content.featureMarkdown).toContain(
      "This is still part of the feature summary.",
    );
    expect(content.featureMarkdown).not.toContain(
      "This is example content, not the feature summary.",
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
});
