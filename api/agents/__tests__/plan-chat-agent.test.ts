import { stepCountIs, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, CreateArtifactInput } from "../../coordination";
import { resolveCodexLanguageModel } from "../../agent-core/codex-language-model";
import type { Env } from "../../types";
import {
  buildPlanContext,
  configurePlanPolicySession,
  createPlanArtifactTools,
  decidePlanToolCall,
  PLAN_ACTIVE_TOOLS,
  PLAN_CONTEXT_TOOL_NAME,
  PLAN_INITIAL_ACTIVE_TOOLS,
  PLAN_POLICY_VERSION,
  PLAN_REPO_TOOL_BOUNDS,
  runBoundedPlanFind,
  runBoundedPlanGrep,
} from "../plan-chat-support";
import { PlanChatWorkspaceProxy } from "../plan-chat-workspace";

class FakeRepoWorkspace {
  private files = new Map<string, string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
    }
  }

  async readWorkspaceFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async readWorkspaceFileBytes(path: string): Promise<Uint8Array | null> {
    const content = this.files.get(path);
    return content == null ? null : new TextEncoder().encode(content);
  }

  readWorkspaceDir(path = "/") {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return Array.from(this.files.entries())
      .filter(([filePath]) => filePath.startsWith(prefix))
      .flatMap(([filePath, content]) => {
        const rest = filePath.slice(prefix.length);
        if (!rest || rest.includes("/")) return [];
        return [{ path: filePath, size: content.length, type: "file" as const }];
      });
  }

  globWorkspace(pattern: string) {
    if (pattern !== "**/*" && pattern !== "*.ts") return [];
    return Array.from(this.files.entries()).map(([path, content]) => ({
      path,
      size: content.length,
      type: "file" as const,
    }));
  }

  statWorkspaceFile(path: string) {
    const content = this.files.get(path);
    return content == null ? null : { path, size: content.length };
  }
}

function createArtifactStoreStub() {
  const artifacts = new Map<string, Artifact>();

  return {
    createArtifact<TBody = unknown>(input: CreateArtifactInput<TBody>): Artifact<TBody> {
      const artifact: Artifact<TBody> = {
        id: input.id ?? crypto.randomUUID(),
        repoId: input.repoId,
        type: input.type,
        basis: input.basis,
        title: input.title,
        body: input.body,
        createdAt: input.createdAt ?? "2026-04-12T00:00:00.000Z",
        updatedAt: input.updatedAt ?? "2026-04-12T00:00:00.000Z",
        status: input.status ?? "draft",
        version: input.version ?? 1,
      };
      artifacts.set(artifact.id, artifact);
      return artifact;
    },
    getArtifact(id: string) {
      return artifacts.get(id) ?? null;
    },
    listArtifacts() {
      return Array.from(artifacts.values());
    },
    savePlan(input: {
      id: string;
      repoId: string;
      expectedVersion: number;
      markdown: string;
      title?: string;
      currentMainCommit: string | null;
    }) {
      const existing = artifacts.get(input.id);
      if (!existing || existing.repoId !== input.repoId || existing.type !== "plan") {
        throw new Error("Plan artifact not found");
      }
      if ((existing.version ?? 1) !== input.expectedVersion) {
        return { status: "conflict" as const, currentVersion: existing.version ?? 1 };
      }
      const next: Artifact = {
        ...existing,
        title: input.title ?? existing.title,
        body: { markdown: input.markdown },
        basis: { ...existing.basis, mainCommit: input.currentMainCommit },
        version: (existing.version ?? 1) + 1,
      };
      artifacts.set(next.id, next);
      return { status: "ok" as const, version: next.version ?? 1, artifact: next };
    },
  };
}

function createResponsesSse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function completedUsage() {
  return { usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("PlanChatAgent Think support", () => {
  it("exposes exactly the planning-safe active tools", () => {
    expect(PLAN_ACTIVE_TOOLS).toEqual([
      PLAN_CONTEXT_TOOL_NAME,
      "read",
      "list",
      "find",
      "grep",
      "read_artifact",
      "list_artifacts",
      "save_plan",
    ]);
    expect(PLAN_INITIAL_ACTIVE_TOOLS).toEqual([
      PLAN_CONTEXT_TOOL_NAME,
      "read",
      "list",
      "find",
      "grep",
      "read_artifact",
      "list_artifacts",
    ]);
    expect(PLAN_INITIAL_ACTIVE_TOOLS).not.toContain("save_plan");
  });

  it("configures a cached readonly Plan policy with the policy version", async () => {
    const calls: Array<{ label: string; options: any }> = [];
    const fakeSession = {
      withContext(label: string, options: any) {
        calls.push({ label, options });
        return fakeSession;
      },
      withCachedPrompt: vi.fn(() => fakeSession),
    };

    expect(configurePlanPolicySession(fakeSession)).toBe(fakeSession);
    expect(fakeSession.withCachedPrompt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].label).toContain(PLAN_POLICY_VERSION.replace(/[^a-zA-Z0-9_]+/g, "_"));
    expect(calls[0].options.provider.set).toBeUndefined();
    await expect(calls[0].options.provider.get()).resolves.toContain(PLAN_POLICY_VERSION);
  });

  it("proxies Think workspace reads to the repo-canonical workspace", async () => {
    const repoWorkspace = new FakeRepoWorkspace({
      "/package.json": "{\"name\":\"demo\"}",
      "/src/index.ts": "export const value = 1;",
    });
    const proxy = new PlanChatWorkspaceProxy();
    proxy.setWorkspace(repoWorkspace as any);

    await expect(proxy.readFile("package.json")).resolves.toContain("demo");
    await expect(proxy.readFileBytes("/src/index.ts")).resolves.toBeInstanceOf(Uint8Array);
    await expect(proxy.readDir("/", { limit: 1 })).resolves.toHaveLength(1);
    await expect(proxy.glob("**/*")).resolves.toEqual([
      expect.objectContaining({ path: "/package.json" }),
      expect.objectContaining({ path: "/src/index.ts" }),
    ]);
    await expect(proxy.stat("package.json")).resolves.toMatchObject({ path: "/package.json", type: "file" });
  });

  it("blocks mutating workspace tools defensively", () => {
    expect(decidePlanToolCall("write")).toMatchObject({ action: "block" });
    expect(decidePlanToolCall("edit")).toMatchObject({ action: "block" });
    expect(decidePlanToolCall("delete")).toMatchObject({ action: "block" });
    expect(decidePlanToolCall("unknown_tool")).toMatchObject({ action: "block" });
    expect(decidePlanToolCall("save_plan")).toMatchObject({ action: "block" });
    expect(decidePlanToolCall("save_plan", { planContextLoaded: true })).toBeUndefined();
  });

  it("builds bounded plan context with plan metadata, repo shape, artifacts, config hints, and truncation notes", async () => {
    const artifacts = createArtifactStoreStub();
    const plan = artifacts.createArtifact({
      id: "plan-1",
      repoId: "repo-123",
      type: "plan",
      basis: { repoId: "repo-123", mainCommit: "abc123" },
      title: "Current plan",
      body: { markdown: `${"x".repeat(80)}\nmore` },
      version: 4,
    });
    const review = artifacts.createArtifact({
      id: "review-1",
      repoId: "repo-123",
      type: "review",
      basis: { repoId: "repo-123", mainCommit: "abc123" },
      title: "Reviewer notes",
      body: { summary: "Check API path", findings: [], relevantFiles: [], openQuestions: [], proposedPlan: "", memoryRefs: [] },
      parentArtifactId: plan.id,
    });
    const workspace = {
      async readFile(path: string) {
        if (path === "/package.json") return "{\"workspaces\":[\"packages/*\"]}";
        return null;
      },
      async writeFile() {},
      async readDir(path = "/") {
        if (path === "/") {
          return [
            { path: "/package.json", size: 32, type: "file" as const },
            { path: "/packages", size: 0, type: "directory" as const },
            { path: "/node_modules", size: 0, type: "directory" as const },
          ];
        }
        if (path === "/") return [];
        if (path === "/packages/app") {
          return [{ path: "/packages/app/src", size: 0, type: "directory" as const }];
        }
        return [];
      },
      async glob(pattern: string) {
        if (pattern === "**/package.json") {
          return [
            { path: "/package.json", size: 32, type: "file" as const },
            { path: "/packages/app/package.json", size: 22, type: "file" as const },
            { path: "/node_modules/pkg/package.json", size: 10, type: "file" as const },
          ];
        }
        if (pattern === "package.json" || pattern === "packages/*/package.json") {
          return [
            { path: "/package.json", size: 32, type: "file" as const },
            { path: "/packages/app/package.json", size: 22, type: "file" as const },
          ];
        }
        return [];
      },
      async getWorkspaceInfo() {
        return { fileCount: 5, directoryCount: 3, totalBytes: 500 };
      },
    };

    const context = await buildPlanContext({
      repo: {
        repoId: "repo-123",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "abc123",
        gitStatus: "ready",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:01:00.000Z",
      },
      plan,
      artifacts: [plan, review],
      workspace,
      maxCurrentPlanChars: 20,
    });

    expect(context.policyVersion).toBe(PLAN_POLICY_VERSION);
    expect(context.plan).toMatchObject({
      id: "plan-1",
      version: 4,
      currentMarkdownTruncated: true,
    });
    expect(JSON.stringify(context.recentArtifacts)).toContain("Reviewer notes");
    expect(context.repo).toMatchObject({ id: "repo-123", mainCommit: "abc123" });
    expect(JSON.stringify(context.workspace)).toContain("/packages/app/package.json");
    expect(JSON.stringify(context.workspace)).not.toContain("node_modules");
    expect(JSON.stringify(context.searchHints)).toContain("defaultExcludeDirs");
    expect(context.truncationNotes).toEqual(expect.arrayContaining([
      expect.stringContaining("currentPlan.markdown truncated"),
    ]));
  });

  it("bounds plan find and grep by entries, files, bytes, matches, context lines, and default exclusions", async () => {
    const files = new Map<string, string>([
      ["/src/a.ts", "alpha\nneedle one\nneedle two"],
      ["/src/b.ts", "needle three\nneedle four"],
      ["/node_modules/pkg/index.ts", "needle dependency"],
      ["/dist/bundle.js", "needle build"],
      ["/src/large.ts", "needle large"],
    ]);
    const workspace = {
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async writeFile() {},
      async readDir() {
        return [];
      },
      async glob() {
        return Array.from(files.entries()).map(([path, content]) => ({
          path,
          size: path.endsWith("large.ts") ? 200 : content.length,
          type: "file" as const,
        }));
      },
      async getWorkspaceInfo() {
        return { fileCount: files.size, directoryCount: 2, totalBytes: 300 };
      },
    };
    const bounds = {
      ...PLAN_REPO_TOOL_BOUNDS,
      maxFilesScanned: 2,
      maxBytesScanned: 80,
      maxMatches: 10,
      maxContextLines: 1,
      maxReturnedEntries: 2,
      maxFileBytes: 100,
    };

    const find = await runBoundedPlanFind(workspace, { pattern: "**/*" }, bounds);
    expect(find.files).toHaveLength(2);
    expect(JSON.stringify(find.files)).not.toContain("node_modules");
    expect(JSON.stringify(find.files)).not.toContain("dist");
    expect(find.truncated).toBe(true);

    const grep = await runBoundedPlanGrep(workspace, {
      query: "needle",
      include: "**/*",
      fixedString: true,
      contextLines: 10,
    }, bounds);
    expect(grep.contextLines).toBe(1);
    expect(grep.filesScanned).toBeLessThanOrEqual(2);
    expect(grep.bytesScanned).toBeLessThanOrEqual(80);
    expect(grep.totalMatches).toBeLessThanOrEqual(10);
    expect(grep.matches).toHaveLength(2);
    expect(JSON.stringify(grep.matches)).not.toContain("node_modules");
    expect(JSON.stringify(grep.matches)).not.toContain("dist");
  });

  it("runs a mocked Codex Responses tool call through the Plan Writer tool set", async () => {
    const artifactStore = createArtifactStoreStub();
    const plan = artifactStore.createArtifact({
      id: "plan-1",
      repoId: "repo-123",
      type: "plan",
      basis: { repoId: "repo-123", mainCommit: "abc123" },
      title: "Mutable plan",
      body: { markdown: "Initial" },
      version: 1,
    });
    const workspace = {
      async readFile() {
        return null;
      },
      async writeFile() {},
      async readDir() {
        return [];
      },
      async glob() {
        return [];
      },
      async getWorkspaceInfo() {
        return { fileCount: 0, directoryCount: 0, totalBytes: 0 };
      },
    };
    const tools = createPlanArtifactTools(workspace, {
      artifactDefaults: { repoId: "repo-123", mainCommit: "abc123" },
      artifactStore,
      savePlanDefaults: {
        repoId: "repo-123",
        planArtifactId: plan.id,
        expectedVersion: 1,
        currentMainCommit: "def456",
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponsesSse([
        {
          type: "response.created",
          response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.5" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "save_plan",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_1",
          delta: JSON.stringify({ markdown: "Updated body", title: "Updated plan" }),
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "save_plan",
            arguments: JSON.stringify({ markdown: "Updated body", title: "Updated plan" }),
            status: "completed",
          },
        },
        {
          type: "response.completed",
          response: completedUsage(),
        },
      ]))
      .mockResolvedValueOnce(createResponsesSse([
        {
          type: "response.created",
          response: { id: "resp_2", created_at: 1_700_000_001, model: "gpt-5.5" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1" },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          delta: "Saved.",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", id: "msg_1" },
        },
        {
          type: "response.completed",
          response: completedUsage(),
        },
      ]));
    const { model } = await resolveCodexLanguageModel({} as Env, {
      chatSessionId: "plan-chat-test",
      model: "gpt-5.5",
      routeOverride: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
        codexRouteStatus: "api_fallback",
      },
      fetch: fetchMock as typeof fetch,
    });
    const result = streamText({
      model,
      prompt: "Save the plan.",
      tools,
      stopWhen: stepCountIs(2),
    });

    await expect(result.text).resolves.toBe("Saved.");
    expect(artifactStore.getArtifact(plan.id)?.body).toEqual({ markdown: "Updated body" });
    expect(artifactStore.getArtifact(plan.id)?.basis.mainCommit).toBe("def456");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
