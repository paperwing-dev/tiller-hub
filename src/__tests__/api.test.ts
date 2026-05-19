import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  createReconnectingWebSocket,
  fetchEnv,
  fetchEnvs,
  fetchHostStatus,
  fetchRepoArtifacts,
  fetchRepos,
  fetchSessions,
  fetchSetupStatus,
  publishProtectHub,
  runArtifactReviewRound,
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
          { key: "OPENAI_API_KEY", mode: "openai-api", ok: true },
          { key: "BROKEN_RESULT" },
        ],
      }), { status: 200 }),
    );

    await expect(verifyModelAuth("https://example.com")).resolves.toEqual({
      ok: false,
      results: [
        {
          key: "OPENAI_API_KEY",
          mode: "openai-api",
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
      new Response(JSON.stringify({ planChatgptAvailable: true }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com")).resolves.toMatchObject({
      hubUrl: "https://example.com",
      currentOrigin: "https://example.com",
      enabledHarnesses: ["claude-code", "codex", "opencode"],
      planChatgptAvailable: true,
      hostGatewayMode: "none",
    });
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

  it("normalizes review rounds with missing reviews", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, draftId: "draft-1" }), { status: 200 }),
    );

    await expect(runArtifactReviewRound("https://example.com", "repo-1", "draft-1")).resolves.toEqual({
      ok: true,
      draftId: "draft-1",
      reviews: [],
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

  it("throws for malformed publish & protect payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        hostname: "hub.example.com",
        hubUrl: "https://hub.example.com",
        clientId: "client-id",
        clientSecret: "client-secret",
        appDomain: "hub.example.com",
      }), { status: 200 }),
    );

    await expect(publishProtectHub("https://example.com", {
      hostname: "hub.example.com",
      apiToken: "token",
      emails: ["user@example.com"],
    })).rejects.toThrow("Malformed publish & protect response");
  });

  it("throws for malformed update check payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ currentVersion: "1.0.0" }), { status: 200 }),
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
