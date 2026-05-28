import { jsonSchema, tool, type ToolSet } from "ai";
import type { Artifact, ArtifactStoreDO } from "../coordination";
import { renderArtifactBodyMarkdown } from "../coordination";
import type {
  AgentSpec,
  HostedTool,
  HostedToolDefinition,
  HostedToolError,
  HostedToolErrorCode,
  HostedToolName,
  HostedToolResult,
  WorkspaceContextAccess,
  WorkspaceEntry,
} from "./types";

const MEMORY_DIR = "/.tiller/memory";

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getInputString(input: Record<string, unknown>, key: string): string | undefined {
  return getString(input[key]);
}

function getInputStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
}

function formatFileInfo(entry: WorkspaceEntry): string {
  return `${entry.type === "directory" ? "d" : "f"} ${entry.path} (${entry.size}b)`;
}

function normalizeMemoryKey(key: string): string {
  const cleaned = key.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return cleaned || "note";
}

function formatArtifactSummary(id: string, title: string, summary: string): string {
  return [id, title, summary].filter(Boolean).join(" :: ");
}

function markdownSummary(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find(Boolean)
    ?.slice(0, 160) ?? "";
}

export class HostedToolExecutionError extends Error {
  readonly toolError: HostedToolError;

  constructor(toolError: HostedToolError) {
    super(toolError.message);
    this.name = "HostedToolExecutionError";
    this.toolError = toolError;
  }
}

function ok(output: unknown): HostedToolResult {
  return { ok: true, output };
}

function fail(
  code: HostedToolErrorCode,
  message: string,
  options: Omit<HostedToolError, "code" | "message"> = {},
): HostedToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...options,
    },
  };
}

export function normalizeHostedToolError(error: unknown): HostedToolError {
  if (error instanceof HostedToolExecutionError) {
    return error.toolError;
  }

  if (error instanceof Error) {
    const message = error.message.trim() || "Hosted tool failed unexpectedly.";
    if (/timeout/i.test(message)) {
      return { code: "timeout", message, retryable: true };
    }
    if (/(unauthorized|forbidden|not authorized|auth)/i.test(message)) {
      return { code: "auth", message };
    }
    if (/(unavailable|temporarily unavailable|gateway)/i.test(message)) {
      return { code: "unavailable", message, retryable: true };
    }
    return { code: "internal", message };
  }

  return {
    code: "internal",
    message: "Hosted tool failed unexpectedly.",
  };
}

export function formatHostedToolError(error: HostedToolError): string {
  return error.message;
}

export function unwrapHostedToolResult(result: HostedToolResult): unknown {
  if (result.ok) {
    return result.output;
  }

  throw new HostedToolExecutionError(result.error);
}

interface ArtifactToolDefaults {
  repoId?: string;
  mainCommit?: string | null;
}

interface ArtifactToolView {
  id: string;
  type: string;
  title: string;
  markdown: string;
  status?: string;
  version?: number;
  updatedAt?: string;
  createdBy?: string;
  createdAt: string;
  basis?: {
    repoId?: string;
    mainCommit?: string | null;
    envSlug?: string;
  };
  parentArtifactId?: string;
  supersedesArtifactId?: string;
}

function toToolArtifactView(artifact: Artifact): ArtifactToolView {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    markdown: renderArtifactBodyMarkdown(artifact.body),
    status: artifact.status,
    version: artifact.version,
    updatedAt: artifact.updatedAt,
    createdAt: artifact.createdAt,
    ...(artifact.createdBy ? { createdBy: artifact.createdBy } : {}),
    ...(artifact.basis ? { basis: artifact.basis } : {}),
    ...(artifact.parentArtifactId ? { parentArtifactId: artifact.parentArtifactId } : {}),
    ...(artifact.supersedesArtifactId ? { supersedesArtifactId: artifact.supersedesArtifactId } : {}),
  };
}

async function listMemoryEntries(workspace: WorkspaceContextAccess): Promise<WorkspaceEntry[]> {
  try {
    return (await workspace
      .readDir(MEMORY_DIR))
      .filter((entry) => entry.type === "file" && entry.path.endsWith(".md"))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

function buildTool(
  definition: HostedToolDefinition,
  execute: (input: Record<string, unknown>) => Promise<HostedToolResult>,
): HostedTool {
  return {
    definition,
    execute: async (input) => {
      try {
        return await execute(input);
      } catch (error) {
        return {
          ok: false,
          error: normalizeHostedToolError(error),
        };
      }
    },
  };
}

export interface HostedToolRegistryOptions {
  artifactDefaults?: ArtifactToolDefaults;
  artifactStore?: Pick<ArtifactStoreDO, "createArtifact" | "getArtifact" | "listArtifacts"> & Partial<Pick<ArtifactStoreDO, "savePlan">>;
  savePlanDefaults?: {
    repoId: string;
    planArtifactId: string;
    expectedVersion: number;
    currentMainCommit: string | null;
  };
}

export function createHostedToolRegistry(
  workspace: WorkspaceContextAccess,
  options: HostedToolRegistryOptions = {},
): Map<HostedToolName, HostedTool> {
  const artifactDefaults = options.artifactDefaults ?? {};
  const artifactStore = options.artifactStore;
  const savePlanDefaults = options.savePlanDefaults
    ? { ...options.savePlanDefaults }
    : null;
  const saveArtifact = async (input: Record<string, unknown>) => {
    const kind = getInputString(input, "type");
    const title = getInputString(input, "title");
    const summary = getInputString(input, "summary");
    const proposedPlan = getInputString(input, "proposedPlan");

    if (!kind || !title || !summary || !proposedPlan) {
      return fail("invalid_input", "type, title, summary, and proposedPlan are required");
    }

    const mainCommit = getInputString(input, "mainCommit") ?? artifactDefaults.mainCommit ?? null;
    const persistedType =
      kind === "plan" ||
      kind === "review" ||
      kind === "decision" ||
      kind === "checkpoint" ||
      kind === "completion"
        ? kind
        : null;
    const repoId = getInputString(input, "repoId") ?? artifactDefaults.repoId;
    if (!artifactStore || !repoId) {
      return fail("unavailable", "Artifact storage is unavailable in this chat.", { retryable: true });
    }

    if (!persistedType) {
      return fail("invalid_input", "Unsupported artifact type. Use plan, review, decision, checkpoint, or completion.");
    }

    if (persistedType === "plan" && !mainCommit) {
      return fail(
        "unavailable",
        "Canonical main commit is not ready yet for this repository. Wait for repo bootstrap to finish before saving a plan.",
        { retryable: true },
      );
    }

    const parentArtifactId = getInputString(input, "parentArtifactId");
    const supersedesArtifactId = getInputString(input, "supersedesArtifactId");

    const created = await artifactStore.createArtifact({
      repoId,
      type: persistedType,
      basis: {
        repoId,
        mainCommit,
      },
      title,
      body: {
        summary,
        findings: getInputStringArray(input, "findings") ?? [],
        relevantFiles: getInputStringArray(input, "relevantFiles") ?? [],
        openQuestions: getInputStringArray(input, "openQuestions") ?? [],
        proposedPlan,
        memoryRefs: getInputStringArray(input, "memoryRefs") ?? [],
        ...(getInputString(input, "model") ? { model: getInputString(input, "model")! } : {}),
      },
      ...(parentArtifactId ? { parentArtifactId } : {}),
      ...(supersedesArtifactId ? { supersedesArtifactId } : {}),
      createdBy: getInputString(input, "createdBy") ?? "hosted-agent",
    });

    const createdView = toToolArtifactView(created);
    return ok(`Saved artifact ${formatArtifactSummary(createdView.id, createdView.title, markdownSummary(createdView.markdown))}`);
  };
  const readArtifact = async (input: Record<string, unknown>) => {
    const id = getInputString(input, "id");
    if (!id) return fail("invalid_input", "id is required");

    if (!artifactStore) {
      return fail("unavailable", "Artifact storage is unavailable in this chat.", { retryable: true });
    }

    const artifact = await artifactStore.getArtifact(id);
    if (!artifact) return fail("not_found", `No artifact found with id ${id}`);
    return ok(JSON.stringify(toToolArtifactView(artifact), null, 2));
  };
  const listArtifacts = async () => {
    if (!artifactStore) {
      return fail("unavailable", "Artifact storage is unavailable in this chat.", { retryable: true });
    }

    const artifacts = await artifactStore.listArtifacts({ limit: 50 });
    return ok(artifacts
      .map((artifact) => toToolArtifactView(artifact))
      .map((artifact) => formatArtifactSummary(artifact.id, artifact.title, markdownSummary(artifact.markdown)))
      .join("\n")
      || "(no saved artifacts)");
  };
  const savePlan = async (input: Record<string, unknown>) => {
    const markdown = getInputString(input, "markdown");
    const title = getInputString(input, "title");
    if (markdown === undefined) {
      return fail("invalid_input", "markdown is required");
    }
    if (!artifactStore?.savePlan || !savePlanDefaults) {
      return fail("unavailable", "Plan saving is unavailable in this chat.", { retryable: true });
    }

    const result = await artifactStore.savePlan({
      repoId: savePlanDefaults.repoId,
      id: savePlanDefaults.planArtifactId,
      expectedVersion: savePlanDefaults.expectedVersion,
      markdown,
      ...(title ? { title } : {}),
      currentMainCommit: savePlanDefaults.currentMainCommit,
    });
    if (result.status === "ok") {
      savePlanDefaults.expectedVersion = result.version;
      return ok({ status: "ok", version: result.version });
    }
    return ok({
      status: "conflict",
      currentVersion: result.currentVersion,
      ...(result.currentTitle ? { currentTitle: result.currentTitle } : {}),
      ...(result.currentMarkdownDigest ? { currentMarkdownDigest: result.currentMarkdownDigest } : {}),
    });
  };
  return new Map<HostedToolName, HostedTool>([
    [
      "read_file",
      buildTool(
        {
          name: "read_file",
          description: "Read the contents of a file at the given path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path starting with /" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const path = getInputString(input, "path");
          if (!path) return fail("invalid_input", "path is required");
          const content = await workspace.readFile(path);
          return content != null ? ok(content) : fail("not_found", `File not found at ${path}`);
        },
      ),
    ],
    [
      "write_file",
      buildTool(
        {
          name: "write_file",
          description: "Write content to a file, creating it if it doesn't exist.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path starting with /" },
              content: { type: "string", description: "The file content to write" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const path = getInputString(input, "path");
          const content = getInputString(input, "content");
          if (!path || content === undefined) return fail("invalid_input", "path and content are required");
          await workspace.writeFile(path, content);
          return ok(`Written ${content.length} bytes to ${path}`);
        },
      ),
    ],
    [
      "list_files",
      buildTool(
        {
          name: "list_files",
          description: "List files and directories in the given directory.",
          parameters: {
            type: "object",
            properties: {
              directory: { type: "string", description: "Directory path (default: /)" },
            },
            required: [],
            additionalProperties: false,
          },
        },
        async (input) => {
          const dir = getInputString(input, "directory") || "/";
          const entries = await workspace.readDir(dir);
          return ok(entries.map(formatFileInfo).join("\n") || "(empty directory)");
        },
      ),
    ],
    [
      "glob",
      buildTool(
        {
          name: "glob",
          description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.tsx).",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Glob pattern" },
            },
            required: ["pattern"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const pattern = getInputString(input, "pattern");
          if (!pattern) return fail("invalid_input", "pattern is required");
          const matches = await workspace.glob(pattern);
          return ok(matches.map(formatFileInfo).join("\n") || "(no matches)");
        },
      ),
    ],
    [
      "save_memory",
      buildTool(
        {
          name: "save_memory",
          description: "Persist a short note for future hosted agents.",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "Memory key, like feature-name or review-note" },
              content: { type: "string", description: "Markdown content to save" },
            },
            required: ["key", "content"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const key = getInputString(input, "key");
          const content = getInputString(input, "content");
          if (!key || content === undefined) return fail("invalid_input", "key and content are required");

          const normalized = normalizeMemoryKey(key);
          const path = `${MEMORY_DIR}/${normalized}.md`;
          await workspace.writeFile(path, content);
          return ok(`Saved memory to ${path}`);
        },
      ),
    ],
    [
      "recall_memory",
      buildTool(
        {
          name: "recall_memory",
          description: "Read one saved memory or list available memories when no key is provided.",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "Optional memory key" },
            },
            required: [],
            additionalProperties: false,
          },
        },
        async (input) => {
          const key = getInputString(input, "key");
          if (key) {
            const path = `${MEMORY_DIR}/${normalizeMemoryKey(key)}.md`;
            const content = await workspace.readFile(path);
            return content != null ? ok(content) : fail("not_found", `No memory found at ${path}`);
          }

          const entries = await listMemoryEntries(workspace);
          return ok(entries.map((entry) => entry.path).join("\n") || "(no saved memories)");
        },
      ),
    ],
    [
      "save_plan",
      buildTool(
        {
          name: "save_plan",
          description: "Save the current Markdown plan in place.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Optional updated plan title" },
              markdown: { type: "string", description: "Full standalone Markdown plan body" },
            },
            required: ["markdown"],
            additionalProperties: false,
          },
        },
        savePlan,
      ),
    ],
    [
      "save_artifact",
      buildTool(
        {
          name: "save_artifact",
          description: "Save a structured artifact for later agents or container sessions.",
          parameters: {
            type: "object",
            properties: {
              type: { type: "string", description: "Artifact type, such as research, plan, or review" },
              title: { type: "string", description: "The title of the artifact" },
              summary: { type: "string", description: "A concise summary of the work completed" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Key findings as an array of strings",
              },
              relevantFiles: {
                type: "array",
                items: { type: "string" },
                description: "Relevant file paths",
              },
              openQuestions: {
                type: "array",
                items: { type: "string" },
                description: "Open questions or uncertainties",
              },
              proposedPlan: { type: "string", description: "Suggested next-step plan or execution brief" },
              memoryRefs: {
                type: "array",
                items: { type: "string" },
                description: "Related memory keys or references",
              },
              parentArtifactId: { type: "string", description: "Optional parent artifact id for reviews or revisions" },
              supersedesArtifactId: { type: "string", description: "Optional artifact id this artifact supersedes" },
              model: { type: "string", description: "Optional model identifier used to produce this artifact" },
              repoId: { type: "string", description: "Optional repository id associated with this artifact" },
              mainCommit: { type: "string", description: "Optional canonical main commit associated with this artifact" },
              createdBy: { type: "string", description: "Optional agent or author name" },
            },
            required: ["type", "title", "summary", "proposedPlan"],
            additionalProperties: false,
          },
        },
        saveArtifact,
      ),
    ],
    [
      "read_artifact",
      buildTool(
        {
          name: "read_artifact",
          description: "Read a previously saved artifact by id.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Artifact id" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        readArtifact,
      ),
    ],
    [
      "list_artifacts",
      buildTool(
        {
          name: "list_artifacts",
          description: "List recently saved artifacts.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        listArtifacts,
      ),
    ],
  ]);
}

export function getHostedToolsForAgent(
  registry: Map<HostedToolName, HostedTool>,
  spec: AgentSpec,
): HostedTool[] {
  return spec.toolNames.map((name) => {
    const tool = registry.get(name);
    if (!tool) {
      throw new Error(`Hosted tool is not registered: ${name}`);
    }
    return tool;
  });
}

export function toAiSdkTools(tools: HostedTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((hostedTool) => [
      hostedTool.definition.name,
      tool({
        description: hostedTool.definition.description,
        inputSchema: jsonSchema(hostedTool.definition.parameters as any),
        execute: async (input) =>
          unwrapHostedToolResult(await hostedTool.execute((input ?? {}) as Record<string, unknown>)),
      }),
    ]),
  );
}

export async function executeHostedTool(
  registry: Map<HostedToolName, HostedTool>,
  name: string,
  input: Record<string, unknown>,
): Promise<HostedToolResult> {
  const tool = registry.get(name as HostedToolName);
  if (!tool) {
    return fail("invalid_input", `Unknown tool: ${name}`);
  }

  return tool.execute(input);
}
