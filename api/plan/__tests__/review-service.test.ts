import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContextAccess, WorkspaceEntry, WorkspaceInfo } from "../../agent-core/types";
import { createScopedReviewWorkspace } from "../scoped-review-workspace";

function createWorkspace(entries: WorkspaceEntry[]): WorkspaceContextAccess {
  const fileContents = new Map(
    entries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, `contents:${entry.path}`]),
  );

  const childrenByDir = new Map<string, WorkspaceEntry[]>();
  for (const entry of entries) {
    const parent =
      entry.path === "/" ? "/" : entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    const current = childrenByDir.get(parent) ?? [];
    current.push(entry);
    childrenByDir.set(parent, current);
  }

  return {
    readFile: vi.fn(async (path: string) => fileContents.get(path) ?? null),
    writeFile: vi.fn(async () => {}),
    readDir: vi.fn(async (path = "/") => childrenByDir.get(path) ?? []),
    glob: vi.fn(async () => entries.filter((entry) => entry.type === "file")),
    getWorkspaceInfo: vi.fn(
      async (): Promise<WorkspaceInfo> => ({
        fileCount: entries.filter((entry) => entry.type === "file").length,
        directoryCount: entries.filter((entry) => entry.type === "directory").length,
        totalBytes: 0,
      }),
    ),
  };
}

const ENTRIES: WorkspaceEntry[] = [
  { path: "/packages", type: "directory", size: 0 },
  { path: "/packages/tiller", type: "directory", size: 0 },
  { path: "/packages/tiller/src", type: "directory", size: 0 },
  { path: "/packages/tiller/src/index.ts", type: "file", size: 10 },
  { path: "/packages/tiller/src/config.ts", type: "file", size: 10 },
  { path: "/packages/tiller/package.json", type: "file", size: 10 },
  { path: "/packages/shared", type: "directory", size: 0 },
  { path: "/packages/shared/src", type: "directory", size: 0 },
  { path: "/packages/shared/src/util.ts", type: "file", size: 10 },
  { path: "/package.json", type: "file", size: 10 },
  { path: "/configs", type: "directory", size: 0 },
  { path: "/configs/base.tsconfig.json", type: "file", size: 10 },
  { path: "/CLAUDE.md", type: "file", size: 10 },
  { path: "/.tiller", type: "directory", size: 0 },
  { path: "/.tiller/CLAUDE.md", type: "file", size: 10 },
];

describe("createScopedReviewWorkspace", () => {
  it("returns the original workspace when no relevant files are provided", async () => {
    const workspace = createWorkspace(ENTRIES);
    expect(createScopedReviewWorkspace(workspace, [])).toBe(workspace);
  });

  it("blocks unrelated files while preserving relevant roots and project context", async () => {
    const workspace = createWorkspace(ENTRIES);
    const scoped = createScopedReviewWorkspace(workspace, [
      "/packages/tiller/src/index.ts",
      "/packages/tiller/src/config.ts",
    ]);

    await expect(scoped.readFile("/packages/tiller/src/index.ts")).resolves.toBe(
      "contents:/packages/tiller/src/index.ts",
    );
    await expect(scoped.readFile("/packages/shared/src/util.ts")).resolves.toBeNull();
    await expect(scoped.readFile("/packages/tiller/package.json")).resolves.toBe(
      "contents:/packages/tiller/package.json",
    );
    await expect(scoped.readFile("/package.json")).resolves.toBe("contents:/package.json");
    await expect(scoped.readFile("/configs/base.tsconfig.json")).resolves.toBe(
      "contents:/configs/base.tsconfig.json",
    );
    await expect(scoped.readFile("/CLAUDE.md")).resolves.toBe("contents:/CLAUDE.md");
    await expect(scoped.readFile("/.tiller/CLAUDE.md")).resolves.toBe("contents:/.tiller/CLAUDE.md");

    await expect(scoped.readDir("/")).resolves.toEqual([
      { path: "/packages", type: "directory", size: 0 },
      { path: "/package.json", type: "file", size: 10 },
      { path: "/configs", type: "directory", size: 0 },
      { path: "/CLAUDE.md", type: "file", size: 10 },
      { path: "/.tiller", type: "directory", size: 0 },
    ]);

    await expect(scoped.glob("/**/*")).resolves.toEqual([
      { path: "/packages/tiller/src/index.ts", type: "file", size: 10 },
      { path: "/packages/tiller/src/config.ts", type: "file", size: 10 },
      { path: "/packages/tiller/package.json", type: "file", size: 10 },
      { path: "/package.json", type: "file", size: 10 },
      { path: "/configs/base.tsconfig.json", type: "file", size: 10 },
      { path: "/CLAUDE.md", type: "file", size: 10 },
      { path: "/.tiller/CLAUDE.md", type: "file", size: 10 },
    ]);
  });
});
