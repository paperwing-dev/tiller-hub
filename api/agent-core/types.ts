export type Awaitable<T> = T | Promise<T>;

export interface WorkspaceEntry {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
}

export interface WorkspaceInfo {
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}

export interface WorkspaceContextAccess {
  readFile(path: string): Awaitable<string | null>;
  readDir(path?: string): Awaitable<WorkspaceEntry[]>;
  glob(pattern: string): Awaitable<WorkspaceEntry[]>;
  getWorkspaceInfo(): Awaitable<WorkspaceInfo>;
}

export interface ReviewerAgentSpec {
  baseInstructions: string;
  maxSteps: number;
  maxContextChars: number;
}
