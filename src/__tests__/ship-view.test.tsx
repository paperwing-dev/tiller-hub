import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";
import ShipView from "../ShipView";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

function makeRepo(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const repo: RepoMeta = {
    repoId: "repo-1",
    artifactStoreGeneration: null,
    repoUrl: "https://github.com/test/repo",
    scmModel: "github",
    githubInstallationId: 98765,
    githubFullName: "test/repo",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-a",
    githubWebhookConfigured: true,
    githubWebhookError: null,
    mainCommit: "main-a",
    gitArtifactId: "git-a",
    gitStatus: "ready",
    gitError: null,
    gitFormatVersion: 1,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
  };
  return Object.assign(repo, overrides);
}

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const env: EnvMeta = {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    scmModel: "github",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    status: "stopped",
    startupPlanId: null,
    branchName: "tiller/demo-env",
    branchStatus: "ready-to-merge",
    workspaceDirty: true,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-05-01T00:00:00.000Z",
    baseMainCommit: "main-a",
    lastKnownMainCommit: "main-a",
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    githubBaseBranch: "main",
    githubBaseCommitSha: "main-a",
    githubBranch: "tiller/env/demo-env",
    githubHeadCommitSha: null,
    githubPrNumber: null,
    githubPrUrl: null,
    githubPrState: null,
    githubMergedAt: null,
    githubPublishStatus: "idle",
    githubPublishOperationId: null,
    githubPublishError: null,
    githubLastPublishedAt: null,
    githubLastPublishedWorkspaceHash: null,
    githubPendingPublish: null,
  };
  return Object.assign(env, overrides);
}

function render(env: EnvMeta, repo = makeRepo()) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/envs/${env.slug}/ship`]}>
      <ShipView
        env={env}
        repo={repo}
        hubUrl="https://hub.test"
      />
    </MemoryRouter>,
  );
}

describe("ShipView actions", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  it("shows create-PR actions for stopped changed envs", () => {
    const html = render(makeEnv());

    expect(html).toContain("Create Draft PR");
    expect(html).toContain("Reset to Main");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("Open in GitHub");
    expect(html).toContain(">Ship<");
  });

  it("shows a GitHub branch link only after a branch head is recorded", () => {
    const html = render(makeEnv({ githubHeadCommitSha: "head-a" }));

    expect(html).toContain("Open in GitHub");
    expect(html).toContain('href="https://github.com/test/repo/tree/tiller/env/demo-env"');
  });

  it("prefers the GitHub PR URL when one is recorded", () => {
    const html = render(makeEnv({
      githubHeadCommitSha: "head-a",
      githubPrUrl: "https://github.com/test/repo/pull/7",
    }));

    expect(html).toContain('href="https://github.com/test/repo/pull/7"');
    expect(html).toContain("Open PR");
  });

  it("gates running envs behind an explicit stop action", () => {
    const html = render(makeEnv({ status: "running" }));

    expect(html).toContain("Stop to review changes");
    expect(html).toContain("Stop to review and ship");
    expect(html).not.toContain("Create Draft PR");
    expect(html).not.toContain("Reset to Main");
    expect(html).not.toContain("Refresh");
  });

  it("hides repo-changing actions while a GitHub publish operation is active", () => {
    const html = render(makeEnv({
      githubPublishStatus: "publishing",
      githubPublishOperationId: "op-1",
    }));

    expect(html).toContain("Publishing the draft PR...");
    expect(html).not.toContain("Create Draft PR");
    expect(html).not.toContain("Reset to Main");
    expect(html).not.toContain("Refresh");
  });

  it("still allows PR creation for changed behind-main envs", () => {
    const html = render(makeEnv({
      branchStatus: "behind-main",
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    }), makeRepo({ mainCommit: "main-b", githubDefaultBranchHeadSha: "main-b" }));

    expect(html).toContain("Create Draft PR");
    expect(html).not.toContain("Reset to Main");
    expect(html).toContain("GitHub default branch has changed");
    expect(html).toContain("ask the agent to pull in main");
  });

  it("keeps workflow permission failures retryable without suggesting a reset", () => {
    const html = render(makeEnv({
      branchStatus: "needs-attention",
      workspaceNeedsAttention: true,
      githubPublishStatus: "failed",
      githubPublishError: "refusing to allow a GitHub App to update workflow files without `workflows` permission",
    }));

    expect(html).toContain("Create Draft PR");
    expect(html).not.toContain("conflicts or unsupported git state");
    expect(html).not.toContain("Shipping is unavailable");
  });

  it("switches to Update Draft PR when an open PR has newer workspace changes", () => {
    const html = render(makeEnv({
      githubPrState: "open",
      githubPrUrl: "https://github.com/test/repo/pull/7",
    }));

    expect(html).toContain("Update Draft PR");
    expect(html).not.toContain("Create Draft PR");
    expect(html).toContain("Open PR");
  });

  it("does not offer a redundant update when an open PR has no newer changes", () => {
    const html = render(makeEnv({
      branchStatus: "up-to-date",
      workspaceDirty: false,
      githubPrState: "open",
      githubPrUrl: "https://github.com/test/repo/pull/7",
    }));

    expect(html).not.toContain("Update Draft PR");
    expect(html).not.toContain("Create Draft PR");
    expect(html).toContain("Open PR");
  });
});
