import { describe, expect, it } from "vitest";
import { derivePlanTitleFromMarkdown, renderArtifactBodyMarkdown } from "../planning";

describe("renderArtifactBodyMarkdown", () => {
  it("returns markdown bodies unchanged", () => {
    expect(renderArtifactBodyMarkdown({ markdown: "# Plan\n\nDo the work." })).toBe("# Plan\n\nDo the work.");
  });

  it("returns empty Markdown for malformed bodies", () => {
    expect(renderArtifactBodyMarkdown({
      summary: "Ship mutable plans",
      findings: ["Existing drafts are immutable"],
    })).toBe("");
  });
});

describe("derivePlanTitleFromMarkdown", () => {
  it("uses an H1 as the plan title", () => {
    expect(derivePlanTitleFromMarkdown("# Sidebar title\n\n## Summary\nBody"))
      .toBe("Sidebar title");
  });

  it("gives H1 precedence when its text is Title", () => {
    expect(derivePlanTitleFromMarkdown("# Title\n\nFollowing paragraph"))
      .toBe("Title");
  });

  it("recognizes an H1 indented by up to three spaces", () => {
    expect(derivePlanTitleFromMarkdown("   # Indented title\n\nBody"))
      .toBe("Indented title");
  });

  it("uses the first value beneath a Title section", () => {
    expect(derivePlanTitleFromMarkdown("## Title\n\nCanonical format title\n\n## Summary\nBody"))
      .toBe("Canonical format title");
  });

  it("ignores heading-looking content in fenced examples", () => {
    expect(derivePlanTitleFromMarkdown("```md\n# Example only\n```\n\n## Summary\nBody"))
      .toBe("");
  });

  it("does not close a fence when the marker has an info string", () => {
    expect(derivePlanTitleFromMarkdown("```md\n````ts\n# Still an example\n````\n\n## Summary\nBody"))
      .toBe("");
  });
});
