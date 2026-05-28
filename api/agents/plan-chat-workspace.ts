import type { WorkspaceDO } from "../workspace/do";
import {
  filterPlanSourceEntries,
  PLAN_REPO_TOOL_BOUNDS,
} from "./plan-chat-support";

interface ReadDirOptions {
  limit?: number;
  offset?: number;
}

export interface PlanChatFileInfo {
  path: string;
  name: string;
  size: number;
  type: "file" | "directory" | "symlink";
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  target?: string;
}

export interface PlanChatWorkspaceLike {
  readFile(path: string): Promise<string | null>;
  readFileBytes(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: string): Promise<void>;
  readDir(path: string, opts?: ReadDirOptions): PlanChatFileInfo[] | Promise<PlanChatFileInfo[]>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  glob(pattern: string): PlanChatFileInfo[] | Promise<PlanChatFileInfo[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): void | Promise<void>;
  stat(path: string): PlanChatFileInfo | null | Promise<PlanChatFileInfo | null>;
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === ".") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function toFileInfo(entry: {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
  updatedAt?: number;
  name?: string;
  mimeType?: string;
  createdAt?: number;
  target?: string;
}): PlanChatFileInfo {
  const path = normalizeWorkspacePath(entry.path);
  const name = entry.name ?? path.split("/").filter(Boolean).pop() ?? "";
  const now = Date.now();
  return {
    path,
    name,
    size: entry.size,
    type: entry.type,
    mimeType: entry.mimeType ?? "text/plain",
    createdAt: entry.createdAt ?? entry.updatedAt ?? now,
    updatedAt: entry.updatedAt ?? now,
    ...(entry.target ? { target: entry.target } : {}),
  };
}

export class PlanChatWorkspaceProxy implements PlanChatWorkspaceLike {
  private workspace: WorkspaceDO | null = null;

  setWorkspace(workspace: WorkspaceDO): void {
    this.workspace = workspace;
  }

  clearWorkspace(): void {
    this.workspace = null;
  }

  private getWorkspace(): WorkspaceDO {
    if (!this.workspace) {
      throw new Error("Plan Writer workspace is not configured for this turn.");
    }
    return this.workspace;
  }

  async readFile(path: string): Promise<string | null> {
    return this.getWorkspace().readWorkspaceFile(normalizeWorkspacePath(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.getWorkspace().readWorkspaceFileBytes(normalizeWorkspacePath(path));
  }

  async writeFile(): Promise<void> {
    throw new Error("Plan Writer workspace is read-only. Use save_plan to update the plan artifact.");
  }

  async readDir(path = "/", opts?: ReadDirOptions): Promise<PlanChatFileInfo[]> {
    const entries = (await this.getWorkspace()
      .readWorkspaceDir(normalizeWorkspacePath(path)))
      .map(toFileInfo);
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit ?? entries.length;
    return entries.slice(offset, offset + Math.max(0, limit));
  }

  async rm(): Promise<void> {
    throw new Error("Plan Writer workspace is read-only. delete is disabled for Plan Writer.");
  }

  async glob(pattern: string): Promise<PlanChatFileInfo[]> {
    return filterPlanSourceEntries((await this.getWorkspace().globWorkspace(pattern)).map(toFileInfo))
      .slice(0, PLAN_REPO_TOOL_BOUNDS.maxReturnedEntries * 5);
  }

  mkdir(): void {
    throw new Error("Plan Writer workspace is read-only. write is disabled for Plan Writer.");
  }

  async stat(path: string): Promise<PlanChatFileInfo | null> {
    const normalizedPath = normalizeWorkspacePath(path);
    const stat = await this.getWorkspace().statWorkspaceFile(normalizedPath);
    if (!stat) return null;
    return toFileInfo({
      path: normalizedPath,
      size: stat.size,
      type: "file",
    });
  }
}
