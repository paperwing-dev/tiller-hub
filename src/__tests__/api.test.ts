import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  createEnv,
  createPlan,
  createRepo,
  createReconnectingWebSocket,
  discardPlan,
  fetchEnv,
  fetchEnvs,
  fetchHostStatus,
  fetchGitHubRepositories,
  fetchRepoArtifacts,
  fetchRepos,
  fetchSessions,
  fetchSetupStatus,
  testGitHubAppAccess,
  verifyCloudflareToken,
  verifyModelAuth,
} from "../api";

describe("fetchRepoArtifacts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes missing artifact arrays to empty arrays", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ refs: undefined }), { status: 200 }),
    );

    await expect(fetchRepoArtifacts("https://example.com", "repo-1")).resolves.toEqual({
      artifacts: [],
      refs: [],
    });
  });

  it("ignores retired array-only artifact responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        id: "artifact-1",
        repoId: "repo-1",
        type: "plan",
        title: "Draft",
        createdAt: "2024-01-01T00:00:00.000Z",
        basis: {
          repoId: "repo-1",
          mainCommit: "abc123",
        },
        body: {
          summary: "Summary",
        },
      }]), { status: 200 }),
    );

    await expect(fetchRepoArtifacts("https://example.com", "repo-1")).resolves.toEqual({
      artifacts: [],
      refs: [],
    });
  });

  it("accepts empty plan titles for untitled drafts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        artifacts: [{
          id: "plan-1",
          repoId: "repo-1",
          type: "plan",
          title: "",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          version: 1,
          status: "draft",
          basis: {
            repoId: "repo-1",
            mainCommit: "abc123",
          },
          body: {
            markdown: "",
          },
        }],
        refs: [],
      }), { status: 200 }),
    );

    await expect(fetchRepoArtifacts("https://example.com", "repo-1")).resolves.toMatchObject({
      artifacts: [{ id: "plan-1", title: "" }],
      refs: [],
    });
  });

  it("normalizes wrapped create-plan responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        artifact: {
          id: "plan-1",
          repoId: "repo-1",
          type: "plan",
          title: "",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
          version: 1,
          status: "draft",
          basis: {
            repoId: "repo-1",
            mainCommit: "abc123",
          },
          body: {
            markdown: "",
          },
        },
      }), { status: 201 }),
    );

    await expect(createPlan("https://example.com", "repo-1")).resolves.toMatchObject({
      id: "plan-1",
      title: "",
      status: "draft",
      version: 1,
    });
  });

  it("normalizes wrapped discard-plan responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        artifact: {
          id: "plan-1",
          repoId: "repo-1",
          type: "plan",
          title: "Draft",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
          version: 2,
          status: "draft",
          basis: {
            repoId: "repo-1",
            mainCommit: "abc123",
          },
          body: {
            markdown: "Draft",
          },
        },
      }), { status: 200 }),
    );

    await expect(discardPlan("https://example.com", "repo-1", "plan-1", 2)).resolves.toMatchObject({
      id: "plan-1",
      status: "draft",
      version: 2,
    });
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/repos/repo-1/plans/plan-1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ expectedVersion: 2 }),
    });
  });
});

describe("list-style api helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes missing session arrays to empty arrays", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
    );

    await expect(fetchSessions("https://example.com")).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/sessions", {
      credentials: "include",
      cache: "no-store",
    });
  });

  it("normalizes missing repo arrays to empty arrays", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ repos: [] }), { status: 200 }),
    );

    await expect(fetchRepos("https://example.com")).resolves.toEqual([]);
  });

  it("throws for malformed env summaries in list responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        slug: "env-1",
        repoUrl: "https://github.com/test/repo",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
      }]), { status: 200 }),
    );

    await expect(fetchEnvs("https://example.com")).rejects.toThrow("Malformed env response");
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/envs", {
      credentials: "include",
      cache: "no-store",
    });
  });

  it("throws for malformed repo summaries in list responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2024-01-01T00:00:00.000Z",
      }]), { status: 200 }),
    );

    await expect(fetchRepos("https://example.com")).rejects.toThrow("Malformed repo response");
  });

  it("creates envs by repoId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        slug: "env-1",
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        backend: "cf",
        harness: "codex",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "creating",
        startupPlanId: null,
        branchName: "env/env-1",
        branchStatus: null,
        workspaceDirty: null,
        workspaceNeedsAttention: null,
        workspaceLastSyncedAt: null,
        baseMainCommit: null,
        lastKnownMainCommit: null,
        scmOperationType: null,
        scmOperationId: null,
        scmOperationPhase: null,
        scmOperationStartedAt: null,
        scmOperationUpdatedAt: null,
        scmLastCompletedAt: null,
        scmLastDurationMs: null,
        scmLastTimings: null,
      }), { status: 201 }),
    );

    await createEnv("https://example.com", "repo-1", "cf", "codex");

    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/envs", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("\"repoId\":\"repo-1\""),
    }));
    expect(fetchSpy.mock.calls[0]?.[1]?.body as string).not.toContain("repoUrl");
  });

  it("creates repos from GitHub App repository selections", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        repoId: "42",
        repoUrl: "https://github.com/test/repo",
        githubInstallationId: 100,
        githubFullName: "test/repo",
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
        gitError: null,
        gitFormatVersion: null,
        gitProgressPhase: null,
        gitProgressStartedAt: null,
        gitProgressUpdatedAt: null,
        gitLastBootstrapDurationMs: null,
        gitLastBootstrapTimings: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        bootstrappedFromRef: "main",
      }), { status: 201 }),
    );

    await createRepo("https://example.com", {
      repositoryId: 42,
      installationId: 100,
      fullName: "test/repo",
      repoUrl: "https://github.com/test/repo",
      private: true,
      defaultBranch: "main",
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/repos", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        repositoryId: 42,
        installationId: 100,
        fullName: "test/repo",
      }),
    }));
  });

  it("normalizes GitHub App repository selections", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        repositories: [{
          repositoryId: 42,
          installationId: 100,
          fullName: "test/repo",
          repoUrl: "https://github.com/test/repo",
          private: true,
          defaultBranch: "main",
        }],
        warnings: [],
        repositorySelection: "all",
      }), { status: 200 }),
    );

    await expect(fetchGitHubRepositories("https://example.com")).resolves.toEqual({
      repositories: [expect.objectContaining({ repositoryId: 42, fullName: "test/repo" })],
      warnings: [],
      repositorySelection: "all",
    });
  });
});

describe("verifyModelAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes missing results to an empty array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "No credentials configured" }), { status: 200 }),
    );

    await expect(verifyModelAuth("https://example.com")).resolves.toEqual({
      ok: false,
      error: "No credentials configured",
      results: [],
    });
  });

  it("drops malformed verification results instead of leaking them into the UI", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        results: [
          null,
          { key: "OPENAI_API_KEY", mode: "api-key", ok: true },
          { key: "BROKEN_RESULT" },
        ],
      }), { status: 200 }),
    );

    await expect(verifyModelAuth("https://example.com")).resolves.toEqual({
      ok: false,
      results: [
        {
          key: "OPENAI_API_KEY",
          mode: "api-key",
          ok: true,
        },
      ],
    });
  });
});

describe("single-object api helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws for malformed env payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        slug: "env-1",
        repoUrl: "https://github.com/test/repo",
        backend: "cf",
      }), { status: 200 }),
    );

    await expect(fetchEnv("https://example.com", "env-1")).rejects.toThrow("Malformed env response");
  });

  it("fills setup status defaults when the payload is partial", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ openaiPlannerAvailable: true }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com")).resolves.toMatchObject({
      hubUrl: "https://example.com",
      currentOrigin: "https://example.com",
      enabledHarnesses: ["claude-code", "codex", "opencode"],
      openaiPlannerAvailable: true,
      hostGatewayMode: "none",
      githubAppInstallUrl: null,
      githubAppManageUrl: "https://github.com/settings/installations",
      githubAppReady: false,
    });
  });

  it("derives setup needs from normalized setup phase", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        needsSetup: true,
        setupPhase: "complete",
      }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com")).resolves.toMatchObject({
      needsSetup: false,
      setupPhase: "complete",
    });
  });

  it("normalizes GitHub App access test responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        status: "missing_permissions",
        message: "Needs pull request permissions.",
        repo: "owner/repo",
        installUrl: "https://github.com/apps/tiller-test/installations/new",
        manageUrl: "https://github.com/settings/installations",
      }), { status: 200 }),
    );

    await expect(testGitHubAppAccess("https://example.com", {
      repositoryId: 42,
      installationId: 1234,
      fullName: "owner/repo",
      repoUrl: "https://github.com/owner/repo",
      private: false,
      defaultBranch: "main",
    })).resolves.toEqual({
      ok: false,
      status: "missing_permissions",
      message: "Needs pull request permissions.",
      repo: "owner/repo",
      installUrl: "https://github.com/apps/tiller-test/installations/new",
      manageUrl: "https://github.com/settings/installations",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/api/github/test-access", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        repositoryId: 42,
        installationId: 1234,
        fullName: "owner/repo",
      }),
    }));
  });

  it("derives host status state when the payload omits the richer fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        connected: true,
        machine: {
          machineId: "host-1",
          connectedAt: "2026-04-13T00:00:00.000Z",
          gatewayUrl: "https://tiller-gateway.example.com",
          gatewayTunnelType: "named",
          codexSubscription: true,
          claudeSubscription: false,
        },
      }), { status: 200 }),
    );

    await expect(fetchHostStatus("https://example.com")).resolves.toEqual({
      registered: true,
      connected: true,
      gatewayConfigured: true,
      gatewayAvailable: true,
      state: "gateway-available",
      machine: {
        machineId: "host-1",
        connectedAt: "2026-04-13T00:00:00.000Z",
        gatewayUrl: "https://tiller-gateway.example.com",
        gatewayTunnelType: "named",
        codexSubscription: true,
        claudeSubscription: false,
      },
    });
  });

  it("throws for malformed Cloudflare token verification payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, hostname: "hub.example.com" }), { status: 200 }),
    );

    await expect(verifyCloudflareToken("https://example.com", {
      hostname: "hub.example.com",
      apiToken: "token",
    })).rejects.toThrow("Malformed Cloudflare token verification response");
  });

  it("throws for malformed update check payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ updateAvailable: true }), { status: 200 }),
    );

    await expect(checkForUpdate("https://example.com")).rejects.toThrow("Malformed update check response");
  });
});

describe("createReconnectingWebSocket", () => {
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    private listeners = new Map<string, Array<(event: any) => void>>();

    constructor(public readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: (event: any) => void) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    send() {}

    close() {
      this.emit("close", { code: 1000 });
    }

    emit(type: string, event: any) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    FakeWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it("replays nested env events and ignores malformed websocket payloads", () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });
    const onEnvUpsert = vi.fn();

    const socket = createReconnectingWebSocket("https://example.com", { onEnvUpsert });
    const ws = FakeWebSocket.instances[0];

    ws.emit("message", {
      data: JSON.stringify({
        type: "replay",
        events: [
          {
            type: "env-upsert",
            env: {
              slug: "env-1",
              repoUrl: "https://github.com/test/repo",
              repoId: "repo-1",
              backend: "cf",
              harness: "claude-code",
              runnerMachineId: "env-1",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              status: "running",
              startupPlanId: null,
              branchName: "env/env-1",
              branchStatus: "up-to-date",
              workspaceDirty: false,
              workspaceNeedsAttention: false,
              workspaceLastSyncedAt: null,
              baseMainCommit: null,
              lastKnownMainCommit: null,
              scmOperationType: null,
              scmOperationId: null,
              scmOperationPhase: null,
              scmOperationStartedAt: null,
              scmOperationUpdatedAt: null,
              scmLastCompletedAt: null,
              scmLastDurationMs: null,
              scmLastTimings: null,
            },
          },
          {
            type: "env-upsert",
            env: {
              repoUrl: "https://github.com/test/repo",
            },
          },
        ],
      }),
    });

    expect(onEnvUpsert).toHaveBeenCalledTimes(1);
    expect(onEnvUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "env-1",
        status: "running",
        harness: "claude-code",
      }),
    );

    socket.close();
  });
});
