import { describe, expect, it } from "vitest";
import { renderArtifactBodyMarkdown } from "../planning";

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
