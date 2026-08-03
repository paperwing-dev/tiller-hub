import type { WorkspaceDO } from "../workspace/do";
import type { WorkspaceContextAccess } from "./types";

export type WorkspaceStub = Pick<
  WorkspaceDO,
  | "readWorkspaceFile"
  | "readWorkspaceDir"
  | "globWorkspace"
  | "getWorkspaceInfo"
>;

export function createWorkspaceAccess(stub: WorkspaceStub): WorkspaceContextAccess {
  return {
    readFile(path: string) {
      return stub.readWorkspaceFile(path);
    },
    readDir(path?: string) {
      return stub.readWorkspaceDir(path);
    },
    glob(pattern: string) {
      return stub.globWorkspace(pattern);
    },
    getWorkspaceInfo() {
      return stub.getWorkspaceInfo();
    },
  };
}
