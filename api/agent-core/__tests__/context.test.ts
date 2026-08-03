import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../context";
import { REVIEWER_AGENT_SPEC } from "../specs";
import type { WorkspaceContextAccess, WorkspaceEntry } from "../types";

class FakeWorkspace implements WorkspaceContextAccess {
  private files = new Map<string, string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) this.files.set(path, content);
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  readDir(path = "/"): WorkspaceEntry[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children: WorkspaceEntry[] = [];
    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      children.push({ path: filePath, size: content.length, type: "file" });
    }
    return children;
  }

  glob(): WorkspaceEntry[] {
    return [];
  }

  getWorkspaceInfo() {
    return {
      fileCount: this.files.size,
      directoryCount: 1,
      totalBytes: Array.from(this.files.values()).reduce((sum, content) => sum + content.length, 0),
    };
  }
}

describe("buildSystemPrompt", () => {
  it("injects the retained workspace summary and project context", async () => {
    const workspace = new FakeWorkspace({
      "/.tiller/CLAUDE.md": "# Project rules\nUse npm only.",
      "/.tiller/memory/repo-note.md": "Retired memory content.",
      "/README.md": "hello",
    });

    const prompt = await buildSystemPrompt(REVIEWER_AGENT_SPEC, workspace);

    expect(prompt).toContain("You are a code review assistant");
    expect(prompt).toContain("<workspace-summary>");
    expect(prompt).toContain("Files: 3");
    expect(prompt).toContain("<project-context");
    expect(prompt).toContain("Use npm only.");
    expect(prompt).not.toContain("<saved-memories>");
    expect(prompt).not.toContain("Retired memory content.");
  });
});
