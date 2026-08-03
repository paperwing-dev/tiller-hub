import { describe, expect, it } from "vitest";
import { createReviewerTools } from "../tools";
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
    return Array.from(this.files.entries())
      .filter(([filePath]) => filePath.startsWith(prefix))
      .map(([filePath, content]) => ({ path: filePath, size: content.length, type: "file" }));
  }

  glob(pattern: string): WorkspaceEntry[] {
    if (pattern !== "**/*.ts") return [];
    return Array.from(this.files.entries())
      .filter(([path]) => path.endsWith(".ts"))
      .map(([path, content]) => ({ path, size: content.length, type: "file" }));
  }

  getWorkspaceInfo() {
    return {
      fileCount: this.files.size,
      directoryCount: 1,
      totalBytes: Array.from(this.files.values()).reduce((sum, content) => sum + content.length, 0),
    };
  }
}

type ExecutableTool = { execute?: (input: unknown) => Promise<unknown> };

describe("hosted reviewer tools", () => {
  it("exposes and executes only the retained read-only tools", async () => {
    const tools = createReviewerTools(new FakeWorkspace({
      "/package.json": '{"name":"tiller-hub"}',
      "/src/index.ts": "export {};",
    })) as Record<string, ExecutableTool>;

    expect(Object.keys(tools)).toEqual(["read_file", "list_files", "glob"]);
    await expect(tools.read_file.execute?.({ path: "/package.json" })).resolves.toBe(
      '{"name":"tiller-hub"}',
    );
    await expect(tools.list_files.execute?.({ directory: "/src" })).resolves.toContain(
      "/src/index.ts",
    );
    await expect(tools.glob.execute?.({ pattern: "**/*.ts" })).resolves.toContain(
      "/src/index.ts",
    );
  });

  it("surfaces reviewer tool failures through the AI SDK adapter", async () => {
    const tools = createReviewerTools(new FakeWorkspace({})) as Record<string, ExecutableTool>;

    await expect(tools.read_file.execute?.({ path: "/missing.txt" })).rejects.toThrow(
      "File not found at /missing.txt",
    );
  });
});
