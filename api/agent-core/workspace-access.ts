import type { WorkspaceDO } from "../workspace/do";
import type { WorkspaceContextAccess, WorkspaceEntry, WorkspaceInfo } from "./types";

export type WorkspaceStub = Pick<
  WorkspaceDO,
  | "readWorkspaceFile"
  | "writeWorkspaceFile"
  | "readWorkspaceDir"
  | "globWorkspace"
  | "getWorkspaceInfo"
>;

export function createWorkspaceAccess(stub: WorkspaceStub): WorkspaceContextAccess {
  return {
    readFile(path: string) {
      return stub.readWorkspaceFile(path);
    },
    writeFile(path: string, content: string) {
      return stub.writeWorkspaceFile(path, content);
    },
    readDir(path?: string): Promise<WorkspaceEntry[]> {
      return Promise.resolve(stub.readWorkspaceDir(path) as unknown as WorkspaceEntry[]);
    },
    glob(pattern: string): Promise<WorkspaceEntry[]> {
      return Promise.resolve(stub.globWorkspace(pattern) as unknown as WorkspaceEntry[]);
    },
    getWorkspaceInfo(): Promise<WorkspaceInfo> {
      return Promise.resolve(stub.getWorkspaceInfo() as unknown as WorkspaceInfo);
    },
  };
}
