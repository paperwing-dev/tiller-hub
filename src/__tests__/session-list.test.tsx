import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";
import SessionList from "../SessionList";

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
  return renderToString(
    <SessionList
      repos={[repo]}
      sessions={[]}
      selectedId={null}
      onSelect={() => undefined}
      envs={[env]}
      hubUrl="https://hub.test"
      onChangesSelect={() => undefined}
    />,
  );
}

describe("SessionList promote actions", () => {
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

  it("shows Promote Preview and Promote to Main for ready-to-merge envs", () => {
    const html = render(makeEnv());

    expect(html).toContain("Promote Preview");
    expect(html).toContain("Promote to Main");
    expect(html).not.toContain("Update from Main");
  });

  it("shows Update from Main instead of Promote for behind-main envs", () => {
    const html = render(makeEnv({
      branchStatus: "behind-main",
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    }), makeRepo({ mainCommit: "main-b" }));

    expect(html).toContain("Update from Main");
    expect(html).not.toContain("Promote Preview");
    expect(html).not.toContain("Promote to Main");
  });

  it("links repository headers to GitHub", () => {
    const html = render(makeEnv());

    expect(html).toContain('href="https://github.com/test/repo"');
    expect(html).toContain(">test/repo</a>");
  });

  it("hides branch, plan-name, and duplicate repo details from env cards", () => {
    const html = render(makeEnv({
      startupPlanId: "plan-1",
      status: "running",
    }));

    expect(html).toContain("Running");
    expect(html).toContain("Cloudflare Containers");
    expect(html).toContain("Claude Code");
    expect(html).not.toContain("New Plan");
    expect(html).not.toContain("Workspace");
    expect(html).not.toContain("No Plan");
    expect(html).not.toContain("Branch:");
    expect(html).not.toContain("tiller/demo-env");
    expect(html).not.toContain("Plan: Selected");
    expect(html).not.toContain("test/repo</p>");
  });
});
