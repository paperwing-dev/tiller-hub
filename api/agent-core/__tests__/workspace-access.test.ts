import { describe, expect, it } from "vitest";
import { createWorkspaceAccess, type WorkspaceStub } from "../workspace-access";

function createStub() {
  const files = new Map<string, string>();

  const stub: WorkspaceStub = {
    async readWorkspaceFile(path: string) {
      return files.get(path) ?? null;
    },
    async writeWorkspaceFile(path: string, content: string) {
      files.set(path, content);
    },
    readWorkspaceDir(path = "/") {
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
    globWorkspace() {
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
    getWorkspaceInfo() {
      return {
        fileCount: files.size,
        directoryCount: 1,
        totalBytes: Array.from(files.values()).reduce((sum, content) => sum + content.length, 0),
        r2FileCount: 0,
      };
    },
  };

  return { files, stub };
}

describe("createWorkspaceAccess", () => {
  it("reads and writes through the provided workspace stub", async () => {
    const workspace = createStub();
    const access = createWorkspaceAccess(workspace.stub);

    await access.writeFile("/src/app.ts", "console.log('app')");

    expect(await access.readFile("/src/app.ts")).toBe("console.log('app')");
    expect(workspace.files.get("/src/app.ts")).toBe("console.log('app')");
  });
});
