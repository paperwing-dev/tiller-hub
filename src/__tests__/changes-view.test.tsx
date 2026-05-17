import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";
import ChangesView from "../ChangesView";

function makeRepo(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    githubInstallationId: 98765,
    githubFullName: "test/repo",
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
    ...overrides,
  };
}

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf",
    harness: "claude-code",
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
    ...overrides,
  };
}

function render(env: EnvMeta, repo = makeRepo()) {
  return renderToStaticMarkup(
    <ChangesView
      env={env}
      repo={repo}
      hubUrl="https://hub.test"
    />,
  );
}

describe("ChangesView actions", () => {
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

  it("shows promote preview actions only for stopped ready-to-merge envs", () => {
    const html = render(makeEnv());

    expect(html).toContain("Promote Preview");
    expect(html).toContain("Promote to Main");
    expect(html).toContain("Reset to Main");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("Update from Main");
  });

  it("hides repo-changing actions when the env is not stopped", () => {
    const html = render(makeEnv({ status: "running" }));

    expect(html).toContain("Stop this environment to enable Promote Preview.");
    expect(html).not.toContain("Promote to Main");
    expect(html).not.toContain("Reset to Main");
    expect(html).not.toContain("Refresh");
  });

  it("hides repo-changing actions while an SCM operation is active", () => {
    const html = render(makeEnv({
      scmOperationType: "merge-into-main",
      scmOperationId: "op-1",
      scmOperationPhase: "Starting sandbox",
    }));

    expect(html).toContain("Promote Preview is unavailable while an SCM operation is in progress.");
    expect(html).not.toContain("Promote to Main");
    expect(html).not.toContain("Reset to Main");
    expect(html).not.toContain("Refresh");
  });

  it("shows Update from Main instead of preview actions for behind-main envs", () => {
    const html = render(makeEnv({
      branchStatus: "behind-main",
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    }), makeRepo({ mainCommit: "main-b" }));

    expect(html).toContain("Update from Main");
    expect(html).toContain("Reset to Main");
    expect(html).not.toContain("Promote to Main");
    expect(html).not.toContain("Refresh");
  });
});
