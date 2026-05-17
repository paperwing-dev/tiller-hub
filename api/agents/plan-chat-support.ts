import { jsonSchema, tool, type ToolSet } from "ai";
import {
  createHostedToolRegistry,
  getHostedToolsForAgent,
  toAiSdkTools,
  type HostedToolRegistryOptions,
} from "../agent-core/tools";
import { getAgentSpec } from "../agent-core/specs";
import type {
  WorkspaceEntry,
  HostedToolName,
  WorkspaceContextAccess,
} from "../agent-core/types";
import type { Artifact } from "../coordination";
import { renderArtifactBodyMarkdown } from "../coordination";
import type { RepoMeta } from "../types";

export const PLAN_MODEL = "gpt-5.5";
export const PLAN_POLICY_VERSION = "plan-chat-v2-2026-05-21";
export const PLAN_POLICY_CONTEXT_LABEL = `plan_policy_${PLAN_POLICY_VERSION.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
export const PLAN_CONTEXT_TOOL_NAME = "get_plan_context";
export const PLAN_TURN_MAX_STEPS = 20;

export const PLAN_POLICY = [
  `Plan Mode policy version: ${PLAN_POLICY_VERSION}`,
  "You are the primary planning assistant for this repository.",
  "Produce and revise one concrete implementation plan in Markdown. The saved plan must be standalone and ready for a coding agent without chat history.",
  `Call ${PLAN_CONTEXT_TOOL_NAME} before saving a plan so you can orient on the current plan, repository shape, and artifact history.`,
  "Use read, list, find, and grep for targeted repository inspection. The workspace is read-only.",
  "The only permitted mutation is save_plan, which updates the versioned plan artifact. Use it only when the requested work creates or changes the plan.",
  "For read-only questions, status checks, or brief explanations, answer directly without saving.",
  "When reviewer feedback is forwarded, treat it as advisory context. Explain material accept/reject decisions when revising.",
  "Saved plans should use compact sections: Summary, Key Changes, Test Plan, and Assumptions/Open Questions.",
].join("\n\n");

export const PLAN_ACTIVE_TOOLS = [
  PLAN_CONTEXT_TOOL_NAME,
  "read",
  "list",
  "find",
  "grep",
  "read_artifact",
  "list_artifacts",
  "save_plan",
] as const;
export const PLAN_INITIAL_ACTIVE_TOOLS = [
  PLAN_CONTEXT_TOOL_NAME,
  "read",
  "list",
  "find",
  "grep",
  "read_artifact",
  "list_artifacts",
] as const;
export const PLAN_MUTATING_WORKSPACE_TOOLS = ["write", "edit", "delete"] as const;

const PLAN_HOSTED_TOOL_NAMES = [
  "save_plan",
  "read_artifact",
  "list_artifacts",
] satisfies HostedToolName[];
const PLAN_ACTIVE_TOOL_SET = new Set<string>(PLAN_ACTIVE_TOOLS);
const PLAN_MUTATING_TOOL_SET = new Set<string>(PLAN_MUTATING_WORKSPACE_TOOLS);

export const PLAN_REPO_TOOL_DEFAULT_EXCLUDE_DIRS = [
  ".git",
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".terraform",
  ".turbo",
  ".wrangler",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
] as const;

export interface PlanRepoToolBounds {
  maxFilesScanned: number;
  maxBytesScanned: number;
  maxMatches: number;
  maxContextLines: number;
  maxReturnedEntries: number;
  maxFileBytes: number;
  maxLineLength: number;
}

export const PLAN_REPO_TOOL_BOUNDS: PlanRepoToolBounds = {
  maxFilesScanned: 120,
  maxBytesScanned: 600_000,
  maxMatches: 80,
  maxContextLines: 2,
  maxReturnedEntries: 200,
  maxFileBytes: 120_000,
  maxLineLength: 500,
};

export type PlanToolCallDecision =
  | { action: "block"; reason?: string }
  | { action: "allow"; input?: Record<string, unknown> }
  | { action: "substitute"; output: unknown; input?: Record<string, unknown> };

export function configurePlanPolicySession<TSession extends {
  withContext(label: string, options?: {
    description?: string;
    maxTokens?: number;
    provider?: { get(): Promise<string | null> };
  }): TSession;
  withCachedPrompt(provider?: { get(): Promise<string | null>; set(content: string): Promise<void> }): TSession;
}>(
  session: TSession,
  promptProvider?: { get(): Promise<string | null>; set(content: string): Promise<void> },
): TSession {
  return session
    .withContext(PLAN_POLICY_CONTEXT_LABEL, {
      description: "Stable readonly Plan Mode policy.",
      maxTokens: 2_000,
      provider: {
        async get() {
          return PLAN_POLICY;
        },
      },
    })
    .withCachedPrompt(promptProvider);
}

export function createPlanArtifactTools(
  workspace: WorkspaceContextAccess,
  options: HostedToolRegistryOptions,
): ToolSet {
  const registry = createHostedToolRegistry(workspace, options);
  const hostedTools = getHostedToolsForAgent(registry, {
    ...getAgentSpec("plan"),
    toolNames: [...PLAN_HOSTED_TOOL_NAMES],
  });
  return toAiSdkTools(hostedTools);
}

export interface PlanToolCallPolicyState {
  planContextLoaded?: boolean;
}

export function decidePlanToolCall(
  toolName: string,
  state: PlanToolCallPolicyState = {},
): PlanToolCallDecision | void {
  if (PLAN_MUTATING_TOOL_SET.has(toolName)) {
    return {
      action: "block",
      reason: "Plan Writer cannot modify workspace files. Use save_plan to update the plan artifact.",
    };
  }

  if (!PLAN_ACTIVE_TOOL_SET.has(toolName)) {
    return {
      action: "block",
      reason: `Tool ${toolName} is not available to Plan Writer.`,
    };
  }

  if (toolName === "save_plan" && !state.planContextLoaded) {
    return {
      action: "block",
      reason: `Call ${PLAN_CONTEXT_TOOL_NAME} successfully before save_plan.`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === ".") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function pathSegments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

export function isDefaultExcludedPlanPath(path: string): boolean {
  const segments = pathSegments(path);
  return segments.some((segment) =>
    (PLAN_REPO_TOOL_DEFAULT_EXCLUDE_DIRS as readonly string[]).includes(segment)
  );
}

export function filterPlanSourceEntries<T extends Pick<WorkspaceEntry, "path">>(entries: T[]): T[] {
  return entries.filter((entry) => !isDefaultExcludedPlanPath(entry.path));
}

function compareEntries(left: Pick<WorkspaceEntry, "path">, right: Pick<WorkspaceEntry, "path">): number {
  return left.path.localeCompare(right.path);
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const withoutFile = normalized.replace(/\/[^/]+$/, "");
  return withoutFile || "/";
}

function basename(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() ?? "";
}

function truncateString(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n...(truncated)`, truncated: true };
}

function compactFirstLine(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find(Boolean)
    ?.slice(0, 180) ?? "";
}

function artifactSummary(artifact: Artifact): Record<string, unknown> {
  const markdown = renderArtifactBodyMarkdown(artifact.body);
  const body = isRecord(artifact.body) ? artifact.body : {};
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    status: artifact.status ?? "draft",
    version: artifact.version ?? 1,
    updatedAt: artifact.updatedAt ?? artifact.createdAt,
    createdAt: artifact.createdAt,
    summary: compactFirstLine(markdown) || getString(body.summary) || "",
    parentArtifactId: artifact.parentArtifactId ?? null,
  };
}

async function safeReadDir(workspace: WorkspaceContextAccess, path = "/"): Promise<WorkspaceEntry[]> {
  try {
    return await workspace.readDir(path);
  } catch {
    return [];
  }
}

async function safeGlob(workspace: WorkspaceContextAccess, pattern: string): Promise<WorkspaceEntry[]> {
  try {
    return await workspace.glob(pattern);
  } catch {
    return [];
  }
}

async function safeReadFile(workspace: WorkspaceContextAccess, path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}

async function findExistingConfigFiles(workspace: WorkspaceContextAccess): Promise<WorkspaceEntry[]> {
  const patterns = [
    "package.json",
    "pnpm-workspace.yaml",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "lerna.json",
    "turbo.json",
    "nx.json",
    "tsconfig.json",
    "vite.config.*",
    "vitest.config.*",
    "wrangler.jsonc",
    "wrangler.toml",
    "AGENTS.md",
    "README.md",
    ".github/workflows/*",
    "packages/*/package.json",
    "packages/*/tsconfig.json",
    "packages/*/vite.config.*",
    "packages/*/vitest.config.*",
  ];

  const byPath = new Map<string, WorkspaceEntry>();
  for (const pattern of patterns) {
    const matches = filterPlanSourceEntries(await safeGlob(workspace, pattern))
      .filter((entry) => entry.type === "file")
      .sort(compareEntries)
      .slice(0, 20);
    for (const entry of matches) byPath.set(entry.path, entry);
  }
  return Array.from(byPath.values()).sort(compareEntries).slice(0, 40);
}

async function inferPackageRoots(workspace: WorkspaceContextAccess): Promise<string[]> {
  const manifests = filterPlanSourceEntries(await safeGlob(workspace, "**/package.json"))
    .filter((entry) => entry.type === "file")
    .sort(compareEntries)
    .slice(0, 40);
  const roots = new Set<string>();
  for (const manifest of manifests) {
    roots.add(dirname(manifest.path));
  }
  if (roots.size === 0 && await safeReadFile(workspace, "/package.json")) {
    roots.add("/");
  }
  return Array.from(roots).sort();
}

async function inferSourceAreas(workspace: WorkspaceContextAccess, packageRoots: string[]): Promise<string[]> {
  const candidateNames = new Set(["api", "app", "lib", "server", "src", "test", "tests", "__tests__"]);
  const areas = new Set<string>();
  const roots = packageRoots.length ? packageRoots : ["/"];
  for (const root of roots.slice(0, 30)) {
    const entries = await safeReadDir(workspace, root);
    for (const entry of entries) {
      if (entry.type !== "directory") continue;
      if (candidateNames.has(basename(entry.path))) {
        areas.add(entry.path);
      }
    }
  }
  return Array.from(areas).sort().slice(0, 60);
}

export interface BuildPlanContextOptions {
  repo: Pick<RepoMeta, "repoId" | "repoUrl" | "mainCommit" | "gitStatus" | "createdAt" | "updatedAt">;
  plan: Artifact;
  artifacts: Artifact[];
  workspace: WorkspaceContextAccess;
  currentPlanMarkdown?: string;
  maxCurrentPlanChars?: number;
  maxRecentArtifacts?: number;
}

export async function buildPlanContext(options: BuildPlanContextOptions): Promise<Record<string, unknown>> {
  const truncationNotes: string[] = [];
  const currentPlanLimit = options.maxCurrentPlanChars ?? 8_000;
  const currentPlanMarkdown = options.currentPlanMarkdown ?? renderArtifactBodyMarkdown(options.plan.body);
  const truncatedPlan = truncateString(currentPlanMarkdown, currentPlanLimit);
  if (truncatedPlan.truncated) {
    truncationNotes.push(`currentPlan.markdown truncated to ${currentPlanLimit} characters`);
  }

  const workspaceInfo = await options.workspace.getWorkspaceInfo();
  const topLevelEntries = filterPlanSourceEntries(await safeReadDir(options.workspace, "/"))
    .sort(compareEntries)
    .slice(0, 40)
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      size: entry.size,
    }));

  const packageRoots = await inferPackageRoots(options.workspace);
  if (packageRoots.length >= 40) {
    truncationNotes.push("packageRoots limited to 40 entries");
  }
  const sourceAreas = await inferSourceAreas(options.workspace, packageRoots);
  if (sourceAreas.length >= 60) {
    truncationNotes.push("sourceAreas limited to 60 entries");
  }
  const keyConfigFiles = await findExistingConfigFiles(options.workspace);

  const recentLimit = options.maxRecentArtifacts ?? 8;
  const recentArtifactSummaries = options.artifacts
    .filter((artifact) => artifact.id !== options.plan.id)
    .sort((left, right) =>
      (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)
    )
    .slice(0, recentLimit)
    .map(artifactSummary);
  if (options.artifacts.length - 1 > recentArtifactSummaries.length) {
    truncationNotes.push(`recentArtifacts limited to ${recentArtifactSummaries.length} of ${options.artifacts.length - 1}`);
  }

  return {
    policyVersion: PLAN_POLICY_VERSION,
    plan: {
      id: options.plan.id,
      title: options.plan.title,
      status: options.plan.status ?? "draft",
      version: options.plan.version ?? 1,
      basis: options.plan.basis,
      createdAt: options.plan.createdAt,
      updatedAt: options.plan.updatedAt ?? options.plan.createdAt,
      currentMarkdown: truncatedPlan.text,
      currentMarkdownChars: currentPlanMarkdown.length,
      currentMarkdownTruncated: truncatedPlan.truncated,
    },
    repo: {
      id: options.repo.repoId,
      url: options.repo.repoUrl,
      mainCommit: options.repo.mainCommit,
      gitStatus: options.repo.gitStatus,
      createdAt: options.repo.createdAt,
      updatedAt: options.repo.updatedAt,
    },
    recentArtifacts: recentArtifactSummaries,
    workspace: {
      fileCount: workspaceInfo.fileCount,
      directoryCount: workspaceInfo.directoryCount,
      totalBytes: workspaceInfo.totalBytes,
      r2FileCount: workspaceInfo.r2FileCount ?? null,
      topLevelEntries,
      packageRoots,
      sourceAreas,
      keyConfigFiles: keyConfigFiles.map((entry) => ({
        path: entry.path,
        size: entry.size,
      })),
    },
    searchHints: {
      broadFind: "Prefer targeted patterns such as packages/*/src/**/*.ts or src/**/*.tsx over **/*.",
      grep: "Use include globs and fixedString=true for literal identifiers. Default repo-tool exclusions skip dependency, build, and cache directories.",
      defaultExcludeDirs: [...PLAN_REPO_TOOL_DEFAULT_EXCLUDE_DIRS],
      bounds: PLAN_REPO_TOOL_BOUNDS,
    },
    truncationNotes,
  };
}

export function createGetPlanContextTool(
  options: BuildPlanContextOptions & { onSuccess?: () => void },
): ToolSet {
  return {
    [PLAN_CONTEXT_TOOL_NAME]: tool({
      description: "Return bounded orientation for Plan Mode: current plan, metadata, recent artifacts, repository shape, config hints, and search guidance.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      }),
      execute: async () => {
        const context = await buildPlanContext(options);
        options.onSuccess?.();
        return context;
      },
    }),
  };
}

function toRegex(query: string, fixedString: boolean, caseSensitive: boolean): RegExp | null {
  try {
    const pattern = fixedString ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : query;
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function runBoundedPlanFind(
  workspace: WorkspaceContextAccess,
  input: Record<string, unknown>,
  bounds: PlanRepoToolBounds = PLAN_REPO_TOOL_BOUNDS,
): Promise<Record<string, unknown>> {
  const pattern = getString(input.pattern);
  if (!pattern) return { error: "pattern is required" };
  const rawMatches = await workspace.glob(pattern);
  const sourceMatches = filterPlanSourceEntries(rawMatches)
    .sort(compareEntries);
  const returned = sourceMatches.slice(0, bounds.maxReturnedEntries);
  return {
    pattern,
    entriesExamined: rawMatches.length,
    excludedEntries: rawMatches.length - sourceMatches.length,
    count: sourceMatches.length,
    files: returned.map((entry) => entry.type === "directory" ? `${entry.path}/` : entry.path),
    bounds: {
      maxReturnedEntries: bounds.maxReturnedEntries,
      defaultExcludeDirs: [...PLAN_REPO_TOOL_DEFAULT_EXCLUDE_DIRS],
    },
    truncated: sourceMatches.length > returned.length,
  };
}

export async function runBoundedPlanGrep(
  workspace: WorkspaceContextAccess,
  input: Record<string, unknown>,
  bounds: PlanRepoToolBounds = PLAN_REPO_TOOL_BOUNDS,
): Promise<Record<string, unknown>> {
  const query = getString(input.query);
  if (!query) return { error: "query is required" };
  const include = getString(input.include) ?? "**/*";
  const fixedString = getBoolean(input.fixedString) ?? false;
  const caseSensitive = getBoolean(input.caseSensitive) ?? false;
  const contextLines = clampInteger(
    getNumber(input.contextLines),
    0,
    bounds.maxContextLines,
    0,
  );
  const regex = toRegex(query, fixedString, caseSensitive);
  if (!regex) return { error: `Invalid regex: ${query}` };

  const rawFiles = await workspace.glob(include);
  const candidateFiles = filterPlanSourceEntries(rawFiles)
    .filter((entry) => entry.type === "file")
    .sort(compareEntries);
  const matches: Array<string | Record<string, unknown>> = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let filesWithMatches = 0;
  let filesSkippedBySize = 0;
  let filesSkippedByBounds = 0;
  let bytesSkippedByBounds = 0;
  let totalMatches = 0;

  for (const file of candidateFiles) {
    if (filesScanned >= bounds.maxFilesScanned) {
      filesSkippedByBounds += 1;
      continue;
    }
    if (file.size > bounds.maxFileBytes) {
      filesSkippedBySize += 1;
      continue;
    }
    if (bytesScanned + file.size > bounds.maxBytesScanned) {
      bytesSkippedByBounds += file.size;
      filesSkippedByBounds += 1;
      continue;
    }

    const content = await workspace.readFile(file.path);
    if (content === null) continue;
    filesScanned += 1;
    bytesScanned += file.size;

    const lines = content.split("\n");
    let hasMatch = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (totalMatches >= bounds.maxMatches || matches.length >= bounds.maxReturnedEntries) break;
      if (!regex.test(lines[index])) continue;
      if (!hasMatch) {
        hasMatch = true;
        filesWithMatches += 1;
      }
      totalMatches += 1;
      const line = lines[index].length > bounds.maxLineLength
        ? `${lines[index].slice(0, bounds.maxLineLength)}...(line truncated)`
        : lines[index];
      if (contextLines > 0) {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length, index + contextLines + 1);
        matches.push({
          file: file.path,
          line: index + 1,
          context: lines.slice(start, end).map((contextLine, offset) => {
            const lineNumber = start + offset + 1;
            const marker = lineNumber === index + 1 ? ">" : " ";
            const text = contextLine.length > bounds.maxLineLength
              ? `${contextLine.slice(0, bounds.maxLineLength)}...(line truncated)`
              : contextLine;
            return `${marker} ${lineNumber}\t${text}`;
          }).join("\n"),
        });
      } else {
        matches.push(`${file.path}:${index + 1}: ${line}`);
      }
    }
  }

  const truncated = totalMatches >= bounds.maxMatches
    || matches.length >= bounds.maxReturnedEntries
    || filesSkippedByBounds > 0
    || bytesSkippedByBounds > 0;

  return {
    query,
    include,
    fixedString,
    caseSensitive,
    contextLines,
    filesConsidered: candidateFiles.length,
    filesScanned,
    bytesScanned,
    filesWithMatches,
    totalMatches,
    matches,
    filesSkippedBySize,
    filesSkippedByBounds,
    bytesSkippedByBounds,
    excludedEntries: rawFiles.length - candidateFiles.length,
    truncated,
    bounds: {
      maxFilesScanned: bounds.maxFilesScanned,
      maxBytesScanned: bounds.maxBytesScanned,
      maxMatches: bounds.maxMatches,
      maxContextLines: bounds.maxContextLines,
      maxReturnedEntries: bounds.maxReturnedEntries,
      maxFileBytes: bounds.maxFileBytes,
      defaultExcludeDirs: [...PLAN_REPO_TOOL_DEFAULT_EXCLUDE_DIRS],
    },
  };
}
