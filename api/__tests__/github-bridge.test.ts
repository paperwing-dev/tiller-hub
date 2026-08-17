import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubBridgeRecord,
  githubBridgeTokenAccess,
  revokeGitHubBridgesForInteractiveEnv,
  validateGitHubBridgeRequest,
} from "../github/bridge";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({
  getRepoWorkspaceForRepoId: vi.fn(),
  loadEnvView: vi.fn(),
}));

vi.mock("../plan/store", () => ({
  getRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
}));

vi.mock("../env/view", () => ({
  loadEnvView: mocks.loadEnvView,
}));

class MemoryKV {
  values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    return {
      keys: Array.from(this.values.keys())
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function makeEnv(): Env {
  return {
    ENVS_KV: new MemoryKV(),
  } as unknown as Env;
}

function bridgeRequest(creds: { id: string; secret: string }) {
  return new Request("https://hub.example.com/api/github/token?repo=example/repo", {
    headers: {
      Authorization: `Bearer ${creds.secret}`,
      "X-Tiller-GitHub-Bridge-Id": creds.id,
    },
  });
}

describe("GitHub bridge validation", () => {
  beforeEach(() => {
    mocks.getRepoWorkspaceForRepoId.mockReset();
    mocks.loadEnvView.mockReset();
  });

  it("accepts an active interactive bridge for the exact repo", async () => {
    const env = makeEnv();
    mocks.loadEnvView.mockResolvedValue({ status: "running", repoId: "repo-id" });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      meta: { repoId: "repo-id", githubFullName: "example/repo" },
    });
    const creds = await createGitHubBridgeRecord(env, {
      subject: { type: "interactive-env", envSlug: "dev" },
      githubFullName: "Example/Repo",
    });

    const result = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo.fullName).toBe("example/repo");
      expect(result.record.allowedRepo).toBe("example/repo");
    }
  });

  it("rejects invalid secrets, inactive subjects, and repo mismatches", async () => {
    const env = makeEnv();
    mocks.loadEnvView.mockResolvedValue({ status: "stopped" });
    const creds = await createGitHubBridgeRecord(env, {
      subject: { type: "interactive-env", envSlug: "dev" },
      githubFullName: "example/repo",
    });

    const invalidSecret = await validateGitHubBridgeRequest(env, bridgeRequest({ ...creds, secret: "wrong" }), "example/repo");
    expect(invalidSecret.ok).toBe(false);
    if (!invalidSecret.ok) expect(invalidSecret.body.code).toBe("github_bridge_secret_invalid");

    mocks.loadEnvView.mockResolvedValue({ status: "running" });
    const mismatch = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/other");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.body.code).toBe("github_bridge_repo_mismatch");

    mocks.loadEnvView.mockResolvedValue({ status: "stopped" });
    const inactive = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.body.code).toBe("github_bridge_subject_inactive");

    mocks.loadEnvView.mockResolvedValue({ status: "failed" });
    const failed = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.body.code).toBe("github_bridge_subject_inactive");

    mocks.loadEnvView.mockResolvedValue({ status: "unknown" });
    const unknown = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.body.code).toBe("github_bridge_subject_inactive");
  });

  it("rejects malformed repos and revoked bridges", async () => {
    const env = makeEnv();
    mocks.loadEnvView.mockResolvedValue({ status: "running" });
    const creds = await createGitHubBridgeRecord(env, {
      subject: { type: "interactive-env", envSlug: "dev" },
      githubFullName: "example/repo",
    });

    const malformed = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "https://github.com/example/repo/pulls");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.body.code).toBe("github_repo_invalid");

    await revokeGitHubBridgesForInteractiveEnv(env, "dev");
    const revoked = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.body.code).toBe("github_bridge_revoked");
  });

  it("rejects expired bridges", async () => {
    const env = makeEnv();
    mocks.loadEnvView.mockResolvedValue({ status: "running" });
    const creds = await createGitHubBridgeRecord(env, {
      subject: { type: "interactive-env", envSlug: "dev" },
      githubFullName: "example/repo",
    });
    const kv = env.ENVS_KV as unknown as MemoryKV;
    const key = Array.from(kv.values.keys())[0];
    expect(key).toBeDefined();
    const record = JSON.parse(kv.values.get(key!) ?? "{}");
    kv.values.set(key!, JSON.stringify({
      ...record,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));

    const expired = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");

    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.body.code).toBe("github_bridge_expired");
  });

  it("rejects a bridge whose stored repository identity no longer matches", async () => {
    const env = makeEnv();
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      meta: { repoId: "repo-id", githubFullName: "example/renamed" },
    });
    const creds = await createGitHubBridgeRecord(env, {
      subject: { type: "github-planner", jobSlug: "planner-job", repoId: "repo-id" },
      githubFullName: "example/repo",
    });

    const result = await validateGitHubBridgeRequest(env, bridgeRequest(creds), "example/repo");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.code).toBe("github_bridge_repo_mismatch");
  });

  it("validates planner and env publish subjects against active repo state", async () => {
    const env = makeEnv();
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      meta: { repoId: "repo-id", githubFullName: "example/repo" },
    });
    const plannerCreds = await createGitHubBridgeRecord(env, {
      subject: { type: "github-planner", jobSlug: "planner-job", repoId: "repo-id" },
      githubFullName: "example/repo",
    });

    const planner = await validateGitHubBridgeRequest(env, bridgeRequest(plannerCreds), "example/repo");
    expect(planner.ok).toBe(true);
    if (planner.ok) expect(githubBridgeTokenAccess(planner.record)).toBe("read");

    mocks.loadEnvView.mockResolvedValue({
      status: "stopped",
      repoId: "repo-id",
      githubPublishOperationId: "op-1",
      githubPublishStatus: "publishing",
    });
    const publishCreds = await createGitHubBridgeRecord(env, {
      subject: {
        type: "github-env-publish",
        jobSlug: "github-env-publish-dev-00000001",
        envSlug: "dev",
        repoId: "repo-id",
        operationId: "op-1",
        tokenAccess: "publish",
      },
      githubFullName: "example/repo",
    });

    const publish = await validateGitHubBridgeRequest(env, bridgeRequest(publishCreds), "example/repo");
    expect(publish.ok).toBe(true);
    if (publish.ok) expect(githubBridgeTokenAccess(publish.record)).toBe("publish");
  });
});
