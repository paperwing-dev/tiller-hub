import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMeta } from "../types";
import { createInitialRepoScmState } from "../scm/model";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  loadTrackedRepo: vi.fn(),
  patchRepoDefaultHeadIfCurrent: vi.fn(),
  broadcastRepoUpsert: vi.fn(),
  broadcastRepoMainChange: vi.fn(),
  compareAndSetConfig: vi.fn(),
}));

vi.mock("../setup/config", () => ({
  getSecret: mocks.getSecret,
}));

vi.mock("../repo/access", () => ({
  loadTrackedRepo: mocks.loadTrackedRepo,
}));

vi.mock("../plan/store", () => ({
  patchRepoDefaultHeadIfCurrent: mocks.patchRepoDefaultHeadIfCurrent,
  repoDefaultHeadIdentityFromMeta: (meta: RepoMeta) => ({
    githubFullName: meta.githubFullName,
    repoUrl: meta.repoUrl,
    githubDefaultBranch: meta.githubDefaultBranch,
    githubDefaultBranchHeadSha: meta.githubDefaultBranchHeadSha,
    gitStatus: meta.gitStatus,
    gitError: meta.gitError,
  }),
}));

const { handleGitHubWebhook } = await import("../github/webhook-service");

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-06-16T00:00:00.000Z";
  return {
    repoId: "42",
    repoUrl: "https://github.com/owner/old",
    githubInstallationId: 1001,
    githubFullName: "owner/old",
    ...createInitialRepoScmState(),
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-old",
    gitStatus: "ready",
    gitError: null,
    createdAt: now,
    updatedAt: now,
    bootstrappedFromRef: "main",
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
    ...overrides,
  };
}

function makeEnv() {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        compareAndSetConfig: mocks.compareAndSetConfig,
        broadcastRepoUpsert: mocks.broadcastRepoUpsert,
        broadcastRepoMainChange: mocks.broadcastRepoMainChange,
      })),
    },
  } as any;
}

async function hmacSha256(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedWebhookRequest(payload: Record<string, unknown>, delivery = "delivery-1"): Promise<{
  request: Request;
  rawBody: ArrayBuffer;
}> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await hmacSha256("webhook-secret", bytes);
  const rawBody = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(rawBody).set(bytes);
  return {
    request: new Request("https://hub.example.com/api/github/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": `sha256=${signature}`,
        "X-GitHub-Delivery": delivery,
        "X-GitHub-Event": "push",
      },
    }),
    rawBody,
  };
}

describe("GitHub webhook service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.getSecret.mockResolvedValue("webhook-secret");
    mocks.compareAndSetConfig.mockResolvedValue(true);
  });

  it.each([
    ["missing", undefined],
    ["invalid", "sha256=00"],
  ] as const)(
    "rejects a %s signature before delivery or repository side effects",
    async (_label, signature) => {
      const bytes = new TextEncoder().encode(JSON.stringify({
        ref: "refs/heads/main",
        repository: { id: 42, full_name: "owner/old" },
      }));
      const rawBody = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const headers = new Headers({
        "X-GitHub-Delivery": "unsigned-delivery",
        "X-GitHub-Event": "push",
      });
      if (signature) headers.set("X-Hub-Signature-256", signature);
      const request = new Request(
        "https://hub.example.com/api/github/webhook",
        { method: "POST", headers },
      );

      await expect(
        handleGitHubWebhook(makeEnv(), request, rawBody),
      ).resolves.toMatchObject({
        status: 401,
        body: { code: "github_webhook_signature_invalid" },
      });
      expect(mocks.compareAndSetConfig).not.toHaveBeenCalled();
      expect(mocks.loadTrackedRepo).not.toHaveBeenCalled();
      expect(mocks.patchRepoDefaultHeadIfCurrent).not.toHaveBeenCalled();
      expect(mocks.broadcastRepoUpsert).not.toHaveBeenCalled();
      expect(mocks.broadcastRepoMainChange).not.toHaveBeenCalled();
    },
  );

  it("updates default head from delivered payload after repo and default branch rename without fetching GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oldRepo = makeRepoMeta();
    const nextRepo = makeRepoMeta({
      repoUrl: "https://github.com/owner/renamed",
      githubFullName: "owner/renamed",
      githubDefaultBranch: "trunk",
      githubDefaultBranchHeadSha: "main-new",
      gitStatus: "pending",
    });
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: oldRepo } });
    mocks.patchRepoDefaultHeadIfCurrent.mockResolvedValue({
      repo: nextRepo,
      changed: true,
      mainChanged: true,
      conflict: false,
    });
    const payload = {
      ref: "refs/heads/trunk",
      before: "main-old",
      after: "main-new",
      installation: { id: 1001 },
      repository: {
        id: 42,
        full_name: "owner/renamed",
        default_branch: "trunk",
      },
    };
    const { request, rawBody } = await signedWebhookRequest(payload);

    await expect(handleGitHubWebhook(makeEnv(), request, rawBody)).resolves.toMatchObject({
      status: 200,
      body: {
        ok: true,
        repoId: "42",
        defaultBranchHeadSha: "main-new",
      },
    });
    expect(mocks.loadTrackedRepo).toHaveBeenCalledWith(expect.anything(), "42");
    expect(mocks.patchRepoDefaultHeadIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      next: expect.objectContaining({
        githubFullName: "owner/renamed",
        repoUrl: "https://github.com/owner/renamed",
        githubDefaultBranch: "trunk",
        githubDefaultBranchHeadSha: "main-new",
        gitStatus: "pending",
        gitError: null,
      }),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.broadcastRepoUpsert).toHaveBeenCalledWith(expect.objectContaining({
      githubFullName: "owner/renamed",
    }));
    expect(mocks.broadcastRepoMainChange).toHaveBeenCalledWith(
      "42",
      "https://github.com/owner/renamed",
      "main-old",
      "main-new",
      null,
    );
  });

  it("retries default branch CAS conflicts only when the reloaded head matches the delivered before SHA", async () => {
    const oldRepo = makeRepoMeta();
    const nextRepo = makeRepoMeta({
      githubDefaultBranchHeadSha: "main-new",
      gitStatus: "pending",
    });
    mocks.loadTrackedRepo
      .mockResolvedValueOnce({ ok: true, repo: { workspace: {}, meta: oldRepo } })
      .mockResolvedValueOnce({ ok: true, repo: { workspace: {}, meta: oldRepo } });
    mocks.patchRepoDefaultHeadIfCurrent
      .mockResolvedValueOnce({
        repo: oldRepo,
        changed: false,
        mainChanged: false,
        conflict: true,
      })
      .mockResolvedValueOnce({
        repo: nextRepo,
        changed: true,
        mainChanged: true,
        conflict: false,
      });
    const payload = {
      ref: "refs/heads/main",
      before: "main-old",
      after: "main-new",
      installation: { id: 1001 },
      repository: {
        id: 42,
        full_name: "owner/old",
        default_branch: "main",
      },
    };
    const { request, rawBody } = await signedWebhookRequest(payload, "delivery-conflict");

    await expect(handleGitHubWebhook(makeEnv(), request, rawBody)).resolves.toMatchObject({
      status: 200,
      body: {
        ok: true,
        repoId: "42",
        defaultBranchHeadSha: "main-new",
      },
    });
    expect(mocks.patchRepoDefaultHeadIfCurrent).toHaveBeenCalledTimes(2);
    expect(mocks.broadcastRepoUpsert).toHaveBeenCalledWith(expect.objectContaining({
      githubDefaultBranchHeadSha: "main-new",
      gitStatus: "pending",
    }));
  });

  it("does not broadcast no-op default branch pushes", async () => {
    const oldRepo = makeRepoMeta();
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: oldRepo } });
    mocks.patchRepoDefaultHeadIfCurrent.mockResolvedValue({
      repo: oldRepo,
      changed: false,
      mainChanged: false,
      conflict: false,
    });
    const payload = {
      ref: "refs/heads/main",
      after: "main-old",
      installation: { id: 1001 },
      repository: {
        id: 42,
        full_name: "owner/old",
        default_branch: "main",
      },
    };
    const { request, rawBody } = await signedWebhookRequest(payload, "delivery-2");

    await expect(handleGitHubWebhook(makeEnv(), request, rawBody)).resolves.toMatchObject({
      status: 200,
      body: {
        ok: true,
        repoId: "42",
        defaultBranchHeadSha: "main-old",
      },
    });
    expect(mocks.patchRepoDefaultHeadIfCurrent.mock.calls[0][0].next).not.toHaveProperty("githubWebhookConfigured");
    expect(mocks.patchRepoDefaultHeadIfCurrent.mock.calls[0][0].next).not.toHaveProperty("githubWebhookError");
    expect(mocks.broadcastRepoUpsert).not.toHaveBeenCalled();
    expect(mocks.broadcastRepoMainChange).not.toHaveBeenCalled();
  });
});
