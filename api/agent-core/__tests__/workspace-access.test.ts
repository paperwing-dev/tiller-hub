import { describe, expect, it } from "vitest";
import { createWorkspaceAccess, type WorkspaceStub } from "../workspace-access";

function createStub() {
  const files = new Map([["/src/app.ts", "console.log('app')"]]);
  const stub: WorkspaceStub = {
    async readWorkspaceFile(path: string) {
      return files.get(path) ?? null;
    },
    async readWorkspaceDir(path = "/") {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return Array.from(files.entries())
        .filter(([filePath]) => filePath.startsWith(prefix))
        .map(([filePath, content]) => ({
          name: filePath.split("/").pop() ?? filePath,
          path: filePath,
          size: content.length,
          mimeType: "text/plain",
          createdAt: Date.now(),
          type: "file" as const,
          updatedAt: Date.now(),
        }));
    },
    async globWorkspace() {
      return Array.from(files.entries()).map(([path, content]) => ({
        name: path.split("/").pop() ?? path,
        path,
        size: content.length,
        mimeType: "text/plain",
        createdAt: Date.now(),
        type: "file" as const,
        updatedAt: Date.now(),
      }));
    },
    async getWorkspaceInfo() {
      return {
        fileCount: files.size,
        directoryCount: 1,
        totalBytes: Array.from(files.values()).reduce((sum, content) => sum + content.length, 0),
        r2FileCount: 0,
      };
    },
  };

  return stub;
}

describe("createWorkspaceAccess", () => {
  it("exposes the retained read-only workspace operations", async () => {
    const access = createWorkspaceAccess(createStub());

    expect(await access.readFile("/src/app.ts")).toBe("console.log('app')");
    expect(await access.readDir("/src")).toHaveLength(1);
    expect(await access.glob("**/*.ts")).toHaveLength(1);
    expect(await access.getWorkspaceInfo()).toMatchObject({ fileCount: 1 });
  });
});
