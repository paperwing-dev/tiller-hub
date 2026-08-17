import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiAuthenticationError,
  ApiActionError,
  ApiReadTimeoutError,
  acknowledgeImplementorAttention,
  acknowledgePlanAttention,
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
  fetchAgentSkills,
  fetchMessages,
  fetchPlanWriter,
  fetchRepoArtifacts,
  fetchRepos,
  fetchReviewSkillInvocation,
  fetchReviewSkillInvocations,
  fetchSessions,
  fetchSetupStatus,
  invokePlanSkill,
  createScribeHandoff,
  savePlan,
  startEnv,
  stopPlanWriter,
  testGitHubAppAccess,
  updatePlanStatus,
  verifyModelAuth,
} from "../api";
import { TerminalRecoveryOverflowError } from "../terminal-recovery";

describe("Skill readers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts empty common instructions and preserves root invocation payloads", async () => {
    const detail = { invocation: { invocationId: "round-1", parentThreadId: "root-1" }, tabs: [], runs: [] };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        skills: [{
          id: "focused",
          surface: "review",
          command: "focused",
          label: "Focused",
          sharedInstructions: "",
          agents: [{ id: "agent-1" }],
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invocations: [{ invocationId: "round-1", parentThreadId: "root-1" }], nextCursor: null }), { status: 200 }));

    await expect(fetchAgentSkills("https://example.com", "repo-1", "review"))
      .resolves.toMatchObject([{ sharedInstructions: "" }]);
    await expect(fetchReviewSkillInvocation("https://example.com", "env-1", "session-1", "round-1"))
      .resolves.toMatchObject({ invocation: { invocationId: "round-1", parentThreadId: "root-1" } });
    await expect(fetchReviewSkillInvocations("https://example.com", "env-1", "session-1"))
      .resolves.toMatchObject({ invocations: [{ invocationId: "round-1", parentThreadId: "root-1" }] });
  });
});

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
      attention: [],
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
      attention: [],
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

  it("normalizes repository attention items and exact acknowledgement conflicts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        artifacts: [],
        refs: [],
        attention: [
          {
            planArtifactId: "plan-1",
            sourceKind: "scribe",
            sourceId: "plan-writer-plan-1",
            token: "2:4",
          },
          { planArtifactId: "plan-1", sourceKind: "unknown", sourceId: "bad", token: "bad" },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "newer token" }), { status: 409 }));

    await expect(fetchRepoArtifacts("https://example.com", "repo-1")).resolves.toMatchObject({
      attention: [{
        planArtifactId: "plan-1",
        sourceKind: "scribe",
        sourceId: "plan-writer-plan-1",
        token: "2:4",
      }],
    });
    const item = { sourceKind: "scribe" as const, sourceId: "plan-writer-plan-1", token: "2:4" };
    await expect(acknowledgePlanAttention("https://example.com", "repo-1", "plan-1", item))
      .resolves.toBe("acknowledged");
    await expect(acknowledgePlanAttention("https://example.com", "repo-1", "plan-1", item))
      .resolves.toBe("conflict");
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://example.com/api/repos/repo-1/plans/plan-1/attention/acknowledge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(item),
      }),
    );
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
        cleanupPending: true,
        cleanupCode: "runtime_cleanup_deferred",
        cleanupWarning: "Plan deleted. Scribe cleanup will finish when Your machine reconnects.",
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
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
      cleanupWarning: "Plan deleted. Scribe cleanup will finish when Your machine reconnects.",
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
        cleanupPending: true,
        cleanupCode: "runtime_cleanup_deferred",
        cleanupWarning: "Plan moved. Scribe cleanup will retry when Your machine reconnects.",
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
        cleanupPending: true,
        cleanupCode: "runtime_cleanup_deferred",
        cleanupWarning: "Plan moved. Scribe cleanup will retry when Your machine reconnects.",
      });
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/repos/repo-1/artifacts/plan-1/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ status: "evaluating", expectedVersion: 2 }),
    });
  });

  it("preserves deferred cleanup metadata when abandoning a Scribe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      writer: {
        lifecycle: "not_running",
        generation: 3,
        provider: "codex",
        model: "gpt-5.5",
        effort: "high",
        basisCommit: "abc123",
        terminalId: "plan-writer-3",
        stopReason: "user",
        synchronization: { state: "up_to_date" },
        editable: true,
      },
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
      cleanupWarning: "Scribe abandoned. Its workload will be cleaned up when the execution backend is available.",
    }), { status: 200 }));

    await expect(stopPlanWriter("https://example.com", "repo-1", "plan-1", 3)).resolves.toMatchObject({
      lifecycle: "not_running",
      generation: 3,
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
      cleanupWarning: "Scribe abandoned. Its workload will be cleaned up when the execution backend is available.",
    });
  });

  it("preserves live Scribe startup progress metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      writer: {
        lifecycle: "starting",
        generation: 4,
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "max",
        basisCommit: "abc123",
        terminalId: "plan-writer-4",
        startup: {
          stage: "launching",
          updatedAt: "2026-08-13T20:00:00.000Z",
        },
        synchronization: { state: "up_to_date" },
        editable: true,
      },
    }), { status: 200 }));

    await expect(fetchPlanWriter("https://example.com", "repo-1", "plan-1"))
      .resolves.toMatchObject({
        lifecycle: "starting",
        startup: {
          stage: "launching",
          updatedAt: "2026-08-13T20:00:00.000Z",
        },
      });
  });

  it("classifies a Cloudflare Access Scribe response as browser authentication", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Cloudflare Access sign in</html>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(fetchPlanWriter("https://example.com", "repo-1", "plan-1"))
      .rejects.toBeInstanceOf(ApiAuthenticationError);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/api/repos/repo-1/plans/plan-1/live-writer",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

});

describe("implementor attention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acknowledges exact tokens and exposes conflicts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "newer token" }), {
        status: 409,
      }));

    await expect(
      acknowledgeImplementorAttention("https://example.com", "env/one", "token-1"),
    ).resolves.toBe("acknowledged");
    await expect(
      acknowledgeImplementorAttention("https://example.com", "env/one", "token-1"),
    ).resolves.toBe("conflict");
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://example.com/api/envs/env%2Fone/implementor-attention/acknowledge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "token-1" }),
      }),
    );
  });
});

describe("invokePlanSkill", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launches the selected Plan skill with an idempotency key", async () => {
    const response = {
      kind: "skill_root",
      invocation: { invocationId: "request-1", parentThreadId: "skill-root-1" },
      reviewers: [],
      runs: [],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(response), { status: 201 }),
    );

    await expect(invokePlanSkill(
      "https://example.com",
      "repo-1",
      "plan-1",
      "plan/review",
      "request-1",
    )).resolves.toEqual({
      ...response,
      invocation: { ...response.invocation, result: null },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/api/repos/repo-1/plans/plan-1/skills/plan%2Freview/invoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ requestId: "request-1" }),
      },
    );
  });

  it("preserves retryable action metadata for ambiguous Plan Skill setup failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "The command marker could not be persisted.",
        code: "skill_command_persistence_failed",
        retryable: true,
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(invokePlanSkill(
      "https://example.com",
      "repo-1",
      "plan-1",
      "plan/review",
      "request-1",
    )).rejects.toMatchObject<ApiActionError>({
      code: "skill_command_persistence_failed",
      retryable: true,
      status: 502,
    });
  });
});

describe("createScribeHandoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes edited reviewer feedback in the Scribe handoff", async () => {
    const contribution = {
      id: "contribution-1",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      sourceKind: "curated_reviewer_handoff",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      provider: "codex",
      model: "gpt-5.5",
      text: "Edited reviewer feedback",
      status: "pending",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      sourceRefs: [{ threadId: "thread-1", messageId: "message-1", runId: "run-1" }],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ contribution, created: true }), { status: 201 }),
    );

    await expect(createScribeHandoff(
      "https://example.com",
      "repo-1",
      "plan-1",
      {
        requestId: "handoff-1",
        sources: [{ threadId: "thread-1", messageId: "message-1" }],
        content: "Edited reviewer feedback",
      },
    )).resolves.toEqual({ contribution, created: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/api/repos/repo-1/plans/plan-1/scribe-handoffs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          requestId: "handoff-1",
          sources: [{ threadId: "thread-1", messageId: "message-1" }],
          content: "Edited reviewer feedback",
        }),
      },
    );
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
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/sessions", expect.objectContaining({
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
    }));
  });

  it("aborts read requests at 15 seconds with a distinguishable timeout error", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null = null;
      vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      });

      const assertion = expect(fetchSessions("https://example.com")).rejects.toMatchObject({
        name: "ApiReadTimeoutError",
        operation: "Sessions",
        deadlineMs: 15_000,
      } satisfies Partial<ApiReadTimeoutError>);
      await vi.advanceTimersByTimeAsync(15_000);

      await assertion;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the read deadline active while the response body is streaming", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null = null;
      vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
        requestSignal = init?.signal ?? null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            requestSignal?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      });

      const assertion = expect(fetchSessions("https://example.com")).rejects.toMatchObject({
        name: "ApiReadTimeoutError",
        operation: "Sessions",
        deadlineMs: 15_000,
      } satisfies Partial<ApiReadTimeoutError>);
      await vi.advanceTimersByTimeAsync(15_000);

      await assertion;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/api/envs", expect.objectContaining({
      credentials: "include",
      cache: "no-store",
    }));
  });

  it("preserves valid catalog-derived harness presentation in env responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        slug: "env-1",
        displayName: "  Implement\n\u001B[31m settings\u200B  ",
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
        displayName: "Implement [31m settings",
        harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
        implementorAttentionToken: null,
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

  it("sends the selected implementation mode when restarting an env", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, slug: "env-1", status: "starting" }), { status: 200 }),
    );

    await startEnv("https://example.com", "env-1", { implementationMode: "fresh" });

    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      implementationMode: "fresh",
    });
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "No credentials configured" }), { status: 200 }),
    );

    await expect(verifyModelAuth("https://example.com", "ANTHROPIC_API_KEY")).resolves.toEqual({
      ok: false,
      error: "No credentials configured",
      results: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/setup/verify-model-auth",
      expect.objectContaining({ body: JSON.stringify({ key: "ANTHROPIC_API_KEY" }) }),
    );
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

  it("identifies an unauthorized setup-status response as expired browser authentication", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toBeInstanceOf(ApiAuthenticationError);
  });

  it("identifies a Cloudflare Access login page returned for setup status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!DOCTYPE html><html><title>Sign in ・ Cloudflare Access</title></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toBeInstanceOf(ApiAuthenticationError);
  });

  it("does not treat a generic HTML API error as expired authentication", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!DOCTYPE html><html><title>Temporary upstream error</title></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    await expect(fetchSetupStatus("https://example.com"))
      .rejects.toThrow("Malformed setup status");
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
    const payload = {
      needsSetup: true,
      setupPhase: "github-app",
      isLocalDev: false,
      installerManaged: true,
      installationRegion: "wnam",
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
      dashboardOnboarding: {
        dismissed: false,
        executionReady: true,
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    await expect(fetchSetupStatus("https://demo.preview.workers.dev"))
      .resolves.toMatchObject({
        setupPhase: "github-app",
        installerManaged: true,
        installationRegion: "wnam",
        workersDevHubUrl: "https://demo.preview.workers.dev",
        enabledHarnesses: ["claude-code", "codex", "opencode"],
      });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev/api/setup/status",
      expect.objectContaining({
        cache: "no-store",
        headers: { Accept: "application/json" },
        redirect: "manual",
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...payload,
      installationRegion: "WNAM",
    }), { status: 200 }));
    await expect(fetchSetupStatus("https://demo.preview.workers.dev"))
      .rejects.toThrow("Malformed setup status");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...payload,
      installationRegion: null,
    }), { status: 200 }));
    await expect(fetchSetupStatus("https://demo.preview.workers.dev"))
      .rejects.toThrow("Malformed setup status");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...payload,
      installerManaged: false,
      installationRegion: "wnam",
    }), { status: 200 }));
    await expect(fetchSetupStatus("https://demo.preview.workers.dev"))
      .resolves.toMatchObject({
        installerManaged: false,
        installationRegion: "wnam",
      });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...payload,
      isLocalDev: true,
      installationRegion: "wnam",
    }), { status: 200 }));
    await expect(fetchSetupStatus("https://demo.preview.workers.dev"))
      .rejects.toThrow("Malformed setup status");
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

  it("normalizes installer-managed release checks", async () => {
    const runtimeDigest = "1".repeat(64);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        kind: "installer-managed",
        updateAvailable: true,
        stableRelease: {
          releaseId: "b".repeat(40),
          version: "0.3.0",
          releaseNotesUrl: "https://example.com/release",
        },
        currentRelease: {
          schemaVersion: 1,
          channel: "release",
          hubVersion: "0.2.54",
          releaseId: "a".repeat(40),
          selfHostRuntimeImage: `docker.io/jamieatlason/tiller-sandbox@sha256:${runtimeDigest}`,
        },
        buildDiagnostics: {
          channel: "release",
          version: "0.2.54",
          workersCiCommitSha: null,
          workersCiBranch: null,
        },
        errors: [],
      }), { status: 200 }),
    );

    const result = await checkForUpdate("https://example.com", { forceRefresh: true });

    expect(result.kind).toBe("installer-managed");
    expect(result.currentRelease.selfHostRuntimeImage).toBe(
      `docker.io/jamieatlason/tiller-sandbox@sha256:${runtimeDigest}`,
    );
    expect(result.stableRelease?.releaseId).toBe("b".repeat(40));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/update/check?refresh=1",
      { credentials: "include", cache: "no-store" },
    );
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
      displayName: "  Safe\nname  ",
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
      implementorAttentionToken: "attention-token",
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
      displayName: "\u0000\u200B",
      incarnationId: "incarnation-2",
      harness: "opencode",
      harnessSettings: null,
      implementorAttentionToken: null,
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
        displayName: "Safe name",
        status: "running",
        harness: "claude-code",
        harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
        implementorAttentionToken: "attention-token",
      }),
    );
    expect(onEnvUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        slug: "env-2",
        harness: "opencode",
        harnessSettings: null,
        implementorAttentionToken: null,
        harnessPresentation: undefined,
      }),
    );
    expect(onEnvUpsert.mock.calls[1]?.[0]).not.toHaveProperty("displayName");

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

  it("backs off repeated short-lived connections until one stays healthy", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });

    const socket = createReconnectingWebSocket("https://example.com", {});
    FakeWebSocket.instances[0].emit("open", {});
    FakeWebSocket.instances[0].emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].emit("open", {});
    FakeWebSocket.instances[1].emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2].emit("open", {});
    vi.advanceTimersByTime(30_000);
    FakeWebSocket.instances[2].emit("close", { code: 1006 });
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
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
      data: JSON.stringify({ type: "capabilities", terminalFastLane: true, terminalMetrics: true }),
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
      terminalMetrics: true,
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
