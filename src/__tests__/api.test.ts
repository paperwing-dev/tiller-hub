import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  cancelScheduledRun,
  createEnv,
  createPlan,
  createRepo,
  createReconnectingWebSocket,
  discardPlan,
  fetchEnv,
  fetchEnvs,
  fetchGitHubRepositories,
  fetchMessages,
  fetchRepoArtifacts,
  fetchRepos,
  fetchSessions,
  fetchSetupStatus,
  savePlan,
  startEnv,
  testGitHubAppAccess,
  updatePlanStatus,
  verifyModelAuth,
} from "../api";
import { TerminalRecoveryOverflowError } from "../terminal-recovery";

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

  it("preserves evaluating plan status in artifact responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        artifacts: [{
          id: "plan-1",
          repoId: "repo-1",
          type: "plan",
          title: "Under review",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          version: 1,
          status: "evaluating",
          basis: {
            repoId: "repo-1",
            mainCommit: "abc123",
          },
          body: {
            markdown: "Review this plan.",
          },
        }],
        refs: [],
      }), { status: 200 }),
    );

    await expect(fetchRepoArtifacts("https://example.com", "repo-1")).resolves.toMatchObject({
      artifacts: [{ id: "plan-1", status: "evaluating" }],
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

  it("sends content-only manual plan saves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        artifact: {
          id: "plan-1",
          repoId: "repo-1",
          type: "plan",
          title: "Draft",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:01:00.000Z",
          version: 3,
          status: "draft",
          basis: { repoId: "repo-1", mainCommit: "abc123" },
          body: { markdown: "# Edited\n" },
        },
      }), { status: 200 }),
    );

    await expect(savePlan("https://example.com", "repo-1", "plan-1", "# Edited\n"))
      .resolves.toMatchObject({ id: "plan-1", version: 3, body: { markdown: "# Edited\n" } });
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/repos/repo-1/plans/plan-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ markdown: "# Edited\n" }),
    });
  });

  it("sends evaluating as a plan status update", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        artifact: {
          id: "plan-1",
          repoId: "repo-1",
          type: "plan",
          title: "Under review",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
          version: 3,
          status: "evaluating",
          basis: {
            repoId: "repo-1",
            mainCommit: "abc123",
          },
          body: {
            markdown: "Review this plan.",
          },
        },
      }), { status: 200 }),
    );

    await expect(updatePlanStatus("https://example.com", "repo-1", "plan-1", "evaluating", 2))
      .resolves.toMatchObject({
        id: "plan-1",
        status: "evaluating",
        version: 3,
      });
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/repos/repo-1/artifacts/plan-1/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ status: "evaluating", expectedVersion: 2 }),
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

  it("bounds terminal history responses before parsing JSON", async () => {
    const body = JSON.stringify([{
      id: "message-1",
      session_id: "session-1",
      content: JSON.stringify({ type: "terminal-output", data: "hello" }),
      seq: 1,
      local_id: null,
      created_at: "2026-07-11T00:00:00.000Z",
    }]);
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));

    await expect(fetchMessages("https://example.com", "session-1", {
      limit: 200,
      maxBytes: bodyBytes,
      signal: new AbortController().signal,
      onBytes: vi.fn(),
    })).resolves.toEqual([expect.objectContaining({ id: "message-1", seq: 1 })]);
    await expect(fetchMessages("https://example.com", "session-1", {
      limit: 200,
      maxBytes: bodyBytes - 1,
      signal: new AbortController().signal,
      onBytes: vi.fn(),
    })).rejects.toBeInstanceOf(TerminalRecoveryOverflowError);
  });

  it("rejects malformed terminal history instead of treating it as empty", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: "message-1",
        session_id: "session-1",
        content: "{}",
        seq: 1,
        local_id: null,
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: "message-1",
        session_id: "session-1",
        content: "{",
        seq: 1,
        local_id: null,
        created_at: "2026-07-11T00:00:00.000Z",
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: "message-1",
        session_id: "session-1",
        content: "{}",
        seq: 1,
        created_at: "2026-07-11T00:00:00.000Z",
      }]), { status: 200 }));

    const request = {
      limit: 200,
      maxBytes: 1024,
      signal: new AbortController().signal,
      onBytes: vi.fn(),
    };
    await expect(fetchMessages("https://example.com", "session-1", request)).rejects.toThrow();
    await expect(fetchMessages("https://example.com", "session-1", request))
      .rejects.toThrow("Invalid terminal history response");
    await expect(fetchMessages("https://example.com", "session-1", request))
      .rejects.toThrow("Invalid terminal history response");
    await expect(fetchMessages("https://example.com", "session-1", request))
      .rejects.toThrow("Invalid terminal history response");
    await expect(fetchMessages("https://example.com", "session-1", request))
      .rejects.toThrow("Invalid terminal history response");
  });

  it("normalizes missing repo arrays to empty arrays", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ repos: [] }), { status: 200 }),
    );

    await expect(fetchRepos("https://example.com")).resolves.toEqual([]);
  });

  it("preserves nested GitHub publish metadata in repo list responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        githubInstallationId: 123,
        githubFullName: "test/repo",
        mainCommit: "main-1",
        gitArtifactId: "artifact-1",
        gitStatus: "ready",
        gitError: null,
        gitFormatVersion: 1,
        gitProgressPhase: null,
        gitProgressStartedAt: null,
        gitProgressUpdatedAt: null,
        gitLastBootstrapDurationMs: null,
        gitLastBootstrapTimings: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
        githubPublish: {
          status: "published",
          branch: "tiller/promote",
          commitSha: "github-sha",
          prNumber: 17,
          prUrl: "https://github.com/test/repo/pull/17",
          sourceEnvSlug: "demo-env",
          operationId: "op-1",
          updatedAt: "2024-01-01T00:01:00.000Z",
          error: null,
        },
      }]), { status: 200 }),
    );

    await expect(fetchRepos("https://example.com")).resolves.toEqual([
      expect.objectContaining({
        repoId: "repo-1",
        githubPublish: expect.objectContaining({
          status: "published",
          branch: "tiller/promote",
          prNumber: 17,
        }),
      }),
    ]);
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

  it("preserves valid catalog-derived harness presentation in env responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        slug: "env-1",
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        incarnationId: "incarnation-1",
        scmModel: "github",
        backend: "cf",
        executionPlacement: { backend: "cf", machineId: null },
        harness: "opencode",
        harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
        harnessPresentation: {
          modelLabel: "Kimi K2.7 Code",
          credentialRequirement: "workers-ai",
          providerKind: "cloudflare-workers-ai",
          providerLabel: "Tiller Hub",
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "stopped",
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
      }]), { status: 200 }),
    );

    await expect(fetchEnvs("https://example.com")).resolves.toEqual([
      expect.objectContaining({
        harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
        harnessPresentation: {
          modelLabel: "Kimi K2.7 Code",
          credentialRequirement: "workers-ai",
          providerKind: "cloudflare-workers-ai",
          providerLabel: "Tiller Hub",
        },
      }),
    ]);
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
        incarnationId: "incarnation-1",
        scmModel: "github",
        backend: "cf",
        executionPlacement: { backend: "cf", machineId: null },
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

    await createEnv("https://example.com", "repo-1", { harness: "codex" });

    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/envs", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("\"repoId\":\"repo-1\""),
    }));
    expect(fetchSpy.mock.calls[0]?.[1]?.body as string).not.toContain("repoUrl");
  });

  it("creates envs with an explicit startup plan selection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        slug: "env-1",
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        incarnationId: "incarnation-1",
        scmModel: "github",
        backend: "cf",
        executionPlacement: { backend: "cf", machineId: null },
        harness: "codex",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "creating",
        startupPlanId: "plan-1",
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

    await createEnv("https://example.com", "repo-1", {
      harness: "codex",
      planSelection: {
        mode: "specific",
        artifactId: "plan-1",
      },
    });

    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      repoId: "repo-1",
      planSelection: {
        mode: "specific",
        artifactId: "plan-1",
      },
    });
  });

  it("serializes schedules and cancels through the canonical Scheduled Run endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        slug: "env-1",
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        incarnationId: "incarnation-1",
        scmModel: "github",
        backend: "host",
        executionPlacement: { backend: "host", machineId: "machine-1" },
        harness: "codex",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
        status: "stopped",
        startupPlanId: "plan-1",
        branchName: "tiller/env/env-1",
        branchStatus: "up-to-date",
        workspaceDirty: false,
        workspaceNeedsAttention: false,
        workspaceLastSyncedAt: null,
        baseMainCommit: "main-sha",
        lastKnownMainCommit: "main-sha",
        scmOperationType: null,
        scmOperationId: null,
        scmOperationPhase: null,
        scmOperationStartedAt: null,
        scmOperationUpdatedAt: null,
        scmLastCompletedAt: null,
        scmLastDurationMs: null,
        scmLastTimings: null,
        scheduledRun: {
          state: "scheduled",
          runAtMs: 1_800_000_000_000,
          timeZone: "America/Los_Angeles",
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await createEnv("https://example.com", "repo-1", {
      harness: "codex",
      planSelection: { mode: "specific", artifactId: "plan-1" },
      schedule: { runAtMs: 1_800_000_000_000, timeZone: "America/Los_Angeles" },
    });
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      schedule: { runAtMs: 1_800_000_000_000, timeZone: "America/Los_Angeles" },
    });

    await cancelScheduledRun("https://example.com", "env-1");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://example.com/api/envs/env-1/scheduled-run/cancel");
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("starts envs without mutating startup plan selection when options are omitted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        slug: "env-1",
        status: "starting",
      }), { status: 200 }),
    );

    await startEnv("https://example.com", "env-1");

    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/envs/env-1/start", expect.objectContaining({
      method: "POST",
      body: "{}",
    }));
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

  it("rejects partial setup status payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        openaiPlannerAvailable: true,
        workersDevHubUrl: "https://demo.preview.workers.dev",
        tokenExpiresAt: "2027-07-16T00:00:00.000Z",
        renewalRecommended: true,
      }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toThrow("Malformed setup status");
  });

  it("accepts only the complete current workers.dev onboarding schema", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        needsSetup: true,
        setupPhase: "github-app",
        isLocalDev: false,
        installerManaged: true,
        workersDevHubUrl: "https://demo.preview.workers.dev",
        modelAuthConfigured: false,
        claudeBillingMode: null,
        openaiBillingMode: null,
        workersAiConfigured: false,
        hasClaudeSubscription: false,
        hasAnthropicKey: false,
        hasChatGPTAuth: false,
        chatgptAuthStatus: "missing",
        hasOpenAIKey: false,
        codexRouteStatus: "unavailable",
        openaiPlannerConfigured: false,
        openaiPlannerAvailable: false,
        openaiPlannerRoute: null,
        openaiPlannerReason: null,
        codexBackendReadiness: { cf: "unavailable", host: "unavailable" },
        hostRegistered: false,
        enabledHarnesses: ["claude-code", "codex", "opencode"],
        protectionMode: "cf-access",
        tokenExpiresAt: null,
        renewalRecommended: false,
        hostConnected: false,
        idleTimeoutMinutes: 15,
        githubAppAvailable: false,
        githubAppConfigured: false,
        githubAppReady: false,
        githubAppSlug: null,
        githubAppInstallUrl: null,
        githubAppManageUrl: "https://github.com/settings/installations",
        githubAppPublicHubDisabled: true,
        buildDiagnostics: {
          channel: "release",
          version: "0.2.36",
          workersCiCommitSha: null,
          workersCiBranch: null,
        },
        selfUpdateRepo: { status: "not_checked", lastDetectedAt: null },
        dashboardOnboarding: {
          dismissed: false,
          executionReady: true,
        },
      }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://demo.preview.workers.dev"))
      .resolves.toMatchObject({
        setupPhase: "github-app",
        installerManaged: true,
        workersDevHubUrl: "https://demo.preview.workers.dev",
        enabledHarnesses: ["claude-code", "codex", "opencode"],
      });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev/api/setup/status",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects removed custom-domain setup fields instead of normalizing them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        workersDevHubUrl: "https://demo.preview.workers.dev",
        routeKind: "custom-domain",
        hostKind: "custom-domain",
        browserProtected: true,
        serviceTokenConfigured: true,
        accessConfigured: true,
      }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toThrow("Malformed setup status");
  });

  it("rejects malformed setup timeout payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ idleTimeoutMinutes: 999 }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toThrow("Malformed setup status");
  });

  it("rejects inconsistent partial setup phase payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        needsSetup: true,
        setupPhase: "complete",
      }), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toThrow("Malformed setup status");
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

  it("throws for malformed update check payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ updateAvailable: true }), { status: 200 }),
    );

    await expect(checkForUpdate("https://example.com")).rejects.toThrow("Malformed update check response");
  });

  it("normalizes installer maintenance results without synthesizing legacy update metadata", async () => {
    const runtimeSha = "0123456789abcdef0123456789abcdef01234567";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        kind: "installer-maintenance",
        updateAvailable: true,
        installedReleaseId: "a".repeat(40),
        stableRelease: {
          releaseId: "b".repeat(40),
          version: "0.3.0",
          releaseNotesUrl: "https://example.com/release",
        },
        currentUpdate: {
          schemaVersion: 1,
          channel: "deploy-button",
          updateMode: "full-source",
          sourceRepo: "paperwing-dev/tiller-hub",
          sourceId: "a".repeat(40),
          version: "0.2.0",
          label: "Tiller Hub v0.2.0",
          managedFiles: ["package.json"],
          selfHostRuntime: {
            imageSourceId: runtimeSha,
            sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSha}`,
          },
        },
        buildDiagnostics: {
          channel: "release",
          version: "0.2.0",
          workersCiCommitSha: null,
          workersCiBranch: null,
        },
      }), { status: 200 }),
    );

    const result = await checkForUpdate("https://example.com");

    expect(result.kind).toBe("installer-maintenance");
    expect(result.currentUpdate.selfHostRuntime).toEqual({
      imageSourceId: runtimeSha,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSha}`,
    });
    expect(result).not.toHaveProperty("latestUpdate");
    expect(result).not.toHaveProperty("hubRepo");
  });
});

describe("createReconnectingWebSocket", () => {
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    static emitCloseOnClose = true;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    private listeners = new Map<string, Array<(event: any) => void>>();

    constructor(public readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: (event: any) => void) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      if (FakeWebSocket.emitCloseOnClose) this.emit("close", { code: 1000 });
    }

    emit(type: string, event: any) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeWebSocket.emitCloseOnClose = true;
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
    const committedEnv = {
      slug: "env-1",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      incarnationId: "incarnation-1",
      scmModel: "github",
      backend: "cf",
      executionPlacement: { backend: "cf", machineId: null },
      harness: "claude-code",
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
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
    };
    const secondEnv = {
      ...committedEnv,
      slug: "env-2",
      incarnationId: "incarnation-2",
      harness: "opencode",
      harnessSettings: null,
      harnessPresentation: {
        modelLabel: "Kimi K2.7 Code",
        credentialRequirement: "workers-ai",
        providerKind: "cloudflare-workers-ai",
        providerLabel: "Tiller Hub",
      },
      branchName: "env/env-2",
    };

    ws.emit("message", {
      data: JSON.stringify({
        type: "replay",
        events: [
          {
            type: "env-upsert",
            env: committedEnv,
          },
          {
            type: "env-upsert",
            env: secondEnv,
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

    expect(onEnvUpsert).toHaveBeenCalledTimes(2);
    expect(onEnvUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        slug: "env-1",
        status: "running",
        harness: "claude-code",
        harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
      }),
    );
    expect(onEnvUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        slug: "env-2",
        harness: "opencode",
        harnessSettings: null,
        harnessPresentation: undefined,
      }),
    );

    socket.close();
  });

  it("returns whether websocket sends are delivered", () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });

    const socket = createReconnectingWebSocket("https://example.com", {});
    const ws = FakeWebSocket.instances[0];

    expect(socket.send({ type: "ping" })).toBe(true);
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({ type: "ping" });

    ws.readyState = FakeWebSocket.CLOSED;
    expect(socket.send({ type: "ping" })).toBe(false);

    socket.close();
  });

  it("ignores stale socket callbacks after a manual reconnect", () => {
    vi.useFakeTimers();
    FakeWebSocket.emitCloseOnClose = false;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });
    const onCapabilities = vi.fn();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const socket = createReconnectingWebSocket("https://example.com", {
      onCapabilities,
      onConnected,
      onDisconnected,
    });
    const stale = FakeWebSocket.instances[0];

    socket.reconnect();
    const current = FakeWebSocket.instances[1];
    current.emit("open", {});
    stale.emit("open", {});
    stale.emit("message", {
      data: JSON.stringify({ type: "capabilities", terminalFastLane: false }),
    });
    stale.emit("close", { code: 1006 });
    vi.advanceTimersByTime(29_999);

    expect(onConnected).toHaveBeenCalledOnce();
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onCapabilities).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.send({ type: "current" })).toBe(true);
    expect(current.sent.map((payload) => JSON.parse(payload))).toContainEqual({ type: "current" });
    socket.close();
  });

  it("dispatches capabilities and terminal ACK messages", () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });
    const onCapabilities = vi.fn();
    const onTerminalInputAck = vi.fn();
    const onTerminalControlAck = vi.fn();

    const socket = createReconnectingWebSocket("https://example.com", {
      onCapabilities,
      onTerminalInputAck,
      onTerminalControlAck,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit("message", {
      data: JSON.stringify({ type: "capabilities", terminalFastLane: true }),
    });
    ws.emit("message", {
      data: JSON.stringify({
        type: "terminal-input-ack",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        ok: true,
      }),
    });
    ws.emit("message", {
      data: JSON.stringify({
        type: "terminal-control-ack",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 2,
        ok: false,
        error: "bad",
      }),
    });

    expect(onCapabilities).toHaveBeenCalledWith({
      type: "capabilities",
      terminalFastLane: true,
    });
    expect(onTerminalInputAck).toHaveBeenCalledWith({
      type: "terminal-input-ack",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      ok: true,
    });
    expect(onTerminalControlAck).toHaveBeenCalledWith({
      type: "terminal-control-ack",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 2,
      ok: false,
      error: "bad",
    });

    socket.close();
  });
});
