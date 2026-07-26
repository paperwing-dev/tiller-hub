export type RuntimeKind = "think" | "direct-tools" | "container";

export type ModelProviderKind = "external-codex" | "workers-ai";

export type HostedToolName =
  | "read_file"
  | "write_file"
  | "list_files"
  | "glob"
  | "save_memory"
  | "recall_memory"
  | "save_plan"
  | "save_artifact"
  | "read_artifact"
  | "list_artifacts";

export type ToolInputValue = string | number | boolean | null;

export type ToolParameterProperty =
  | { type: "string"; description: string }
  | { type: "array"; description: string; items: { type: "string" } };

export type ToolParameters = {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required: string[];
  additionalProperties: false;
};

export type Awaitable<T> = T | Promise<T>;

export interface WorkspaceEntry {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
  updatedAt?: number;
}

export interface WorkspaceInfo {
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  r2FileCount?: number;
}

export interface WorkspaceToolAccess {
  readFile(path: string): Awaitable<string | null>;
  writeFile(path: string, content: string): Awaitable<void>;
  readDir(path?: string): Awaitable<WorkspaceEntry[]>;
  glob(pattern: string): Awaitable<WorkspaceEntry[]>;
}

export interface WorkspaceContextAccess extends WorkspaceToolAccess {
  getWorkspaceInfo(): Awaitable<WorkspaceInfo>;
}

export interface HostedToolDefinition {
  name: HostedToolName;
  description: string;
  parameters: ToolParameters;
}

export type HostedToolErrorCode =
  | "invalid_input"
  | "not_found"
  | "auth"
  | "timeout"
  | "unavailable"
  | "internal";

export interface HostedToolError {
  code: HostedToolErrorCode;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export type HostedToolResult =
  | { ok: true; output: unknown }
  | { ok: false; error: HostedToolError };

export interface HostedTool {
  definition: HostedToolDefinition;
  execute(input: Record<string, unknown>): Promise<HostedToolResult>;
}

export interface ModelTarget {
  provider: ModelProviderKind;
  envModelKey?: "OPENAI_MODEL";
  defaultModel?: string;
}

export type HostedAgentId = "reviewer-chat";

export interface HostedAgentMetadata {
  id: HostedAgentId;
  name: string;
  label: string;
  runtime: RuntimeKind;
  provider: ModelProviderKind;
  model: string;
}

export interface AgentSpec {
  name: string;
  runtime: RuntimeKind;
  modelTarget: ModelTarget;
  toolNames: HostedToolName[];
  baseInstructions: string;
  maxSteps?: number;
  includeProjectContext?: boolean;
  includeMemories?: boolean;
  includeRecentArtifacts?: boolean;
  injectWorkspaceSummary?: boolean;
  maxMemoryFiles?: number;
  maxRecentArtifacts?: number;
  maxContextChars?: number;
}

export interface PlanReviewIssue {
  issue: string;
  evidenceQuote: string;
  recommendedChange: string;
}

export interface PlanReviewIssueStats {
  total: number;
  kept: number;
  dropped: number;
}

export interface PlanReviewMeta {
  toolCallCount: number;
  finishReason?: string;
  truncated?: boolean;
  warningCount?: number;
  repaired?: boolean;
  retriedForToolUse?: boolean;
}
