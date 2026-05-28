import { describe, expect, it } from "vitest";
import type { Workspace, FileInfo } from "@cloudflare/shell";
import { buildSystemPrompt } from "../context";
import type { AgentSpec } from "../types";

const CONTEXT_TEST_SPEC: AgentSpec = {
  name: "context-test",
  runtime: "direct-tools",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/test",
  },
  toolNames: ["read_file", "list_files", "glob"],
  baseInstructions: "You are a helpful coding assistant.",
  includeProjectContext: true,
  includeMemories: true,
  includeRecentArtifacts: true,
  injectWorkspaceSummary: true,
  maxMemoryFiles: 6,
  maxRecentArtifacts: 3,
  maxContextChars: 20_000,
};

class FakeWorkspace {
  private files = new Map<string, string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
    }
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  readDir(path = "/"): FileInfo[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children = new Map<string, FileInfo>();

    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      children.set(filePath, {
        path: filePath,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      } as FileInfo);
    }

    return Array.from(children.values());
  }

  getWorkspaceInfo() {
    return {
      fileCount: this.files.size,
      directoryCount: 1,
      totalBytes: Array.from(this.files.values()).reduce((sum, content) => sum + content.length, 0),
      r2FileCount: 0,
    };
  }
}

describe("buildSystemPrompt", () => {
  it("injects project context, memories, and recent artifacts into the prompt", async () => {
    const workspace = new FakeWorkspace({
      "/.tiller/CLAUDE.md": "# Project rules\nUse pnpm only.",
      "/.tiller/memory/repo-note.md": "Remember that deploys happen on Fridays.",
      "/README.md": "hello",
    }) as unknown as Workspace;

    const prompt = await buildSystemPrompt(CONTEXT_TEST_SPEC, workspace, {
      recentArtifactsPrompt: [
        "<recent-artifacts>",
        '<artifact id="123" kind="research" createdAt="2026-03-27T00:00:00.000Z">',
        "Title: Understand the build pipeline",
        "Summary: Vite and Wrangler are both part of the deploy path.",
        "</artifact>",
        "</recent-artifacts>",
      ].join("\n"),
    });

    expect(prompt).toContain("You are a helpful coding assistant");
    expect(prompt).toContain("<project-context");
    expect(prompt).toContain("Use pnpm only.");
    expect(prompt).toContain("<saved-memories>");
    expect(prompt).toContain("deploys happen on Fridays");
    expect(prompt).toContain("<recent-artifacts>");
    expect(prompt).toContain("Understand the build pipeline");
    expect(prompt).not.toContain("<recent-handoffs>");
  });
});
