import { describe, expect, it } from "vitest";
import type { Workspace, FileInfo } from "@cloudflare/shell";
import type { Artifact, CreateArtifactInput } from "../../coordination";
import {
  createHostedToolRegistry,
  executeHostedTool,
  getHostedToolsForAgent,
  toAiSdkTools,
} from "../tools";
import { PLAN_AGENT_SPEC } from "../specs";
import type { AgentSpec } from "../types";

const MEMORY_TOOL_TEST_SPEC: AgentSpec = {
  name: "memory-tool-test",
  runtime: "direct-tools",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/test",
  },
  toolNames: [
    "read_file",
    "write_file",
    "list_files",
    "glob",
    "save_memory",
    "recall_memory",
  ],
  baseInstructions: "Exercise shared hosted workspace and memory tools.",
};

class FakeWorkspace {
  private files = new Map<string, string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
    }
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  readDir(path = "/"): FileInfo[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries: FileInfo[] = [];

    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      entries.push({
        path: filePath,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      } as FileInfo);
    }

    return entries;
  }

  glob(pattern: string): FileInfo[] {
    if (pattern === "**/*") {
      return Array.from(this.files.entries()).map(([path, content]) => ({
        path,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      })) as FileInfo[];
    }

    return [];
  }
}

function createArtifactStoreStub() {
  const artifacts = new Map<string, Artifact>();

  return {
    createArtifact<TBody = unknown>(input: CreateArtifactInput<TBody>): Artifact<TBody> {
      const artifact: Artifact<TBody> = {
        id: crypto.randomUUID(),
        repoId: input.repoId,
        type: input.type as Artifact["type"],
        basis: input.basis,
        title: input.title,
        body: input.body,
        ...(input.parentArtifactId ? { parentArtifactId: input.parentArtifactId } : {}),
        ...(input.supersedesArtifactId ? { supersedesArtifactId: input.supersedesArtifactId } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: input.updatedAt ?? input.createdAt ?? "2026-04-12T00:00:00.000Z",
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
        updatedAt: "2026-04-12T00:01:00.000Z",
      };
      artifacts.set(next.id, next);
      return { status: "ok" as const, version: next.version ?? 1, artifact: next };
    },
  };
}

describe("hosted tools", () => {
  it("includes shared workspace tools and can save memory", async () => {
    const workspace = new FakeWorkspace({
      "/package.json": '{"name":"tiller-hub"}',
    }) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace);
    const tools = getHostedToolsForAgent(registry, MEMORY_TOOL_TEST_SPEC);

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "read_file",
      "write_file",
      "list_files",
      "glob",
      "save_memory",
      "recall_memory",
    ]);

    const saveMemory = await executeHostedTool(registry, "save_memory", {
      key: "release-notes",
      content: "Ship local runner changes carefully.",
    });
    expect(saveMemory.ok).toBe(true);
    if (!saveMemory.ok) throw new Error("expected save_memory success");
    expect(String(saveMemory.output)).toContain("/.tiller/memory/release-notes.md");

    const recallMemory = await executeHostedTool(registry, "recall_memory", { key: "release-notes" });
    expect(recallMemory.ok).toBe(true);
    if (!recallMemory.ok) throw new Error("expected recall_memory success");
    expect(String(recallMemory.output)).toContain("Ship local runner changes carefully.");
  });

  it("rejects artifact tools when no artifact store is available", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace);

    const saveArtifact = await executeHostedTool(registry, "save_artifact", {
      type: "plan",
      title: "Review the monorepo",
      summary: "Saved a repo-scoped draft.",
      proposedPlan: "Inspect packages and propose changes.",
    });
    expect(saveArtifact.ok).toBe(false);
    if (saveArtifact.ok) throw new Error("expected save_artifact failure");
    expect(saveArtifact.error.code).toBe("unavailable");
    expect(saveArtifact.error.message).toContain("Artifact storage is unavailable");

    const readArtifact = await executeHostedTool(registry, "read_artifact", { id: "artifact-1" });
    expect(readArtifact.ok).toBe(false);
    if (readArtifact.ok) throw new Error("expected read_artifact failure");
    expect(readArtifact.error.message).toContain("Artifact storage is unavailable");

    const listArtifacts = await executeHostedTool(registry, "list_artifacts", {});
    expect(listArtifacts.ok).toBe(false);
    if (listArtifacts.ok) throw new Error("expected list_artifacts failure");
    expect(listArtifacts.error.message).toContain("Artifact storage is unavailable");
  });

  it("saves and reads repo-scoped artifacts through ArtifactStoreDO", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const artifactStore = createArtifactStoreStub();
    const registry = createHostedToolRegistry(workspace, {
      artifactDefaults: {
        repoId: "repo-123",
        mainCommit: "abc123",
      },
      artifactStore,
    });
    const tools = getHostedToolsForAgent(registry, PLAN_AGENT_SPEC);

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "read_artifact",
      "list_artifacts",
      "save_plan",
    ]);

    const saveResult = await executeHostedTool(registry, "save_artifact", {
      type: "plan",
      title: "Review the monorepo",
      summary: "Saved a repo-scoped draft.",
      proposedPlan: "Inspect packages and propose changes.",
      model: "gpt-5.5",
    });

    expect(saveResult.ok).toBe(true);
    if (!saveResult.ok) throw new Error("expected save_artifact success");
    const savedId = String(saveResult.output).match(/[0-9a-f-]{36}/)?.[0];
    expect(savedId).toBeTruthy();

    const readResult = await executeHostedTool(registry, "read_artifact", { id: savedId });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error("expected read_artifact success");
    expect(String(readResult.output)).toContain('"repoId": "repo-123"');
    expect(String(readResult.output)).toContain('"mainCommit": "abc123"');

    const listResult = await executeHostedTool(registry, "list_artifacts", {});
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) throw new Error("expected list_artifacts success");
    expect(String(listResult.output)).toContain("Review the monorepo");
  });

  it("saves a mutable plan and updates expected version within the turn", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const artifactStore = createArtifactStoreStub();
    const plan = artifactStore.createArtifact({
      repoId: "repo-123",
      type: "plan",
      basis: { repoId: "repo-123", mainCommit: "abc123" },
      title: "Mutable plan",
      body: { markdown: "Initial" },
      status: "draft",
      version: 1,
    });
    const registry = createHostedToolRegistry(workspace, {
      artifactDefaults: {
        repoId: "repo-123",
        mainCommit: "abc123",
      },
      artifactStore,
      savePlanDefaults: {
        repoId: "repo-123",
        planArtifactId: plan.id,
        expectedVersion: 1,
        currentMainCommit: "def456",
      },
    });

    const saveResult = await executeHostedTool(registry, "save_plan", {
      title: "Updated plan",
      markdown: "Updated body",
    });
    expect(saveResult.ok).toBe(true);
    if (!saveResult.ok) throw new Error("expected save_plan success");
    expect(saveResult.output).toEqual({ status: "ok", version: 2 });

    const conflict = await executeHostedTool(registry, "save_plan", {
      markdown: "Second update in the same turn",
    });
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) throw new Error("expected second save_plan success");
    expect(conflict.output).toEqual({ status: "ok", version: 3 });
  });

  it("returns save_plan conflicts as ok tool results", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const artifactStore = createArtifactStoreStub();
    const plan = artifactStore.createArtifact({
      repoId: "repo-123",
      type: "plan",
      basis: { repoId: "repo-123", mainCommit: "abc123" },
      title: "Mutable plan",
      body: { markdown: "Initial" },
      status: "draft",
      version: 2,
    });
    const registry = createHostedToolRegistry(workspace, {
      artifactDefaults: {
        repoId: "repo-123",
        mainCommit: "abc123",
      },
      artifactStore,
      savePlanDefaults: {
        repoId: "repo-123",
        planArtifactId: plan.id,
        expectedVersion: 1,
        currentMainCommit: "abc123",
      },
    });

    const result = await executeHostedTool(registry, "save_plan", {
      markdown: "Stale update",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected conflict result to stay ok");
    expect(result.output).toMatchObject({ status: "conflict", currentVersion: 2 });

    const retry = await executeHostedTool(registry, "save_plan", {
      markdown: "Retry with stale update",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("expected retry conflict result to stay ok");
    expect(retry.output).toMatchObject({ status: "conflict", currentVersion: 2 });
    expect(artifactStore.getArtifact(plan.id)?.body).toEqual({ markdown: "Initial" });
  });

  it("rejects unsupported artifact types", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace, {
      artifactDefaults: {
        repoId: "repo-123",
        mainCommit: "abc123",
      },
      artifactStore: createArtifactStoreStub(),
    });

    const saveResult = await executeHostedTool(registry, "save_artifact", {
      type: "research",
      title: "Explore the monorepo",
      summary: "Looked around.",
      proposedPlan: "Keep exploring.",
    });

    expect(saveResult.ok).toBe(false);
    if (saveResult.ok) throw new Error("expected save_artifact failure");
    expect(saveResult.error.code).toBe("invalid_input");
    expect(saveResult.error.message).toContain("Unsupported artifact type");
  });

  it("rejects saving plan artifacts before canonical main is ready", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace, {
      artifactDefaults: {
        repoId: "repo-123",
      },
      artifactStore: createArtifactStoreStub(),
    });

    const saveResult = await executeHostedTool(registry, "save_artifact", {
      type: "plan",
      title: "Review the monorepo",
      summary: "Saved a repo-scoped draft.",
      proposedPlan: "Inspect packages and propose changes.",
    });

    expect(saveResult.ok).toBe(false);
    if (saveResult.ok) throw new Error("expected save_artifact failure");
    expect(saveResult.error.code).toBe("unavailable");
    expect(saveResult.error.message).toContain("Canonical main commit is not ready");
  });

  it("surfaces hosted tool failures through the shared AI SDK adapter", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace);
    const tools = getHostedToolsForAgent(registry, MEMORY_TOOL_TEST_SPEC);
    const aiTools = toAiSdkTools(tools) as Record<string, { execute?: (input: unknown) => Promise<unknown> }>;

    await expect(aiTools.read_file.execute?.({ path: "/missing.txt" })).rejects.toThrow(
      "File not found at /missing.txt",
    );
  });
});
