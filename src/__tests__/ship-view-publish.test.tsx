/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  navigate: vi.fn(),
  fetchEnvChangeFile: vi.fn(),
  fetchEnvChanges: vi.fn(),
  publishEnvDraftPr: vi.fn(),
  resetEnvToRepo: vi.fn(),
  stopEnv: vi.fn(),
}));

vi.mock("react-router", async () => ({
  ...(await vi.importActual<typeof import("react-router")>("react-router")),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../Toast", () => ({
  useToast: () => mocks.addToast,
}));

vi.mock("../theme", () => ({
  useResolvedTheme: () => "light",
}));

vi.mock("../api", () => ({
  fetchEnvChangeFile: mocks.fetchEnvChangeFile,
  fetchEnvChanges: mocks.fetchEnvChanges,
  publishEnvDraftPr: mocks.publishEnvDraftPr,
  resetEnvToRepo: mocks.resetEnvToRepo,
  stopEnv: mocks.stopEnv,
}));

import ShipView from "../ShipView";

const previousPublishedAt = "2026-07-15T00:00:00.000Z";
const completedPublishedAt = "2026-07-16T00:00:00.000Z";

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
    createdAt: previousPublishedAt,
    updatedAt: previousPublishedAt,
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
    createdAt: previousPublishedAt,
    updatedAt: previousPublishedAt,
    status: "stopped",
    startupPlanId: null,
    branchName: "tiller/demo-env",
    branchStatus: "ready-to-merge",
    workspaceDirty: true,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: previousPublishedAt,
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
    githubLastPublishedAt: previousPublishedAt,
    githubLastPublishedWorkspaceHash: null,
    githubPendingPublish: null,
  };
  return Object.assign(env, overrides);
}

function publishingEnv(operationId = "operation-1"): EnvMeta {
  return makeEnv({
    updatedAt: "2026-07-15T12:00:00.000Z",
    githubPublishStatus: "publishing",
    githubPublishOperationId: operationId,
  });
}

function renderShip(
  env: EnvMeta,
  callbacks: {
    onRecoverEnv?: (slug: string, status?: string) => void;
    onRecoverEntities?: (options?: { slug?: string; repoId?: string }) => void;
  } = {},
) {
  return render(
    <ShipView
      env={env}
      repo={makeRepo()}
      hubUrl="https://hub.test"
      onRecoverEnv={callbacks.onRecoverEnv}
      onRecoverEntities={callbacks.onRecoverEntities}
    />,
  );
}

async function acceptPublish(buttonName: "Create Draft PR" | "Update Draft PR" = "Create Draft PR") {
  fireEvent.click(await screen.findByRole("button", { name: buttonName }));
  await waitFor(() => expect(mocks.publishEnvDraftPr).toHaveBeenCalledWith(
    "https://hub.test",
    "demo-env",
  ));
}

describe("ShipView publish completion", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "React", { configurable: true, value: React });
    mocks.fetchEnvChanges.mockResolvedValue({
      slug: "demo-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/test/repo",
      comparisonBasis: "draft-pr-diff",
      oldCommit: "main-a",
      newBaseCommit: "main-a",
      branchStatus: "ready-to-merge",
      summary: { total: 1, added: 0, modified: 1, deleted: 0 },
      files: [],
    });
    mocks.fetchEnvChangeFile.mockResolvedValue(null);
    mocks.publishEnvDraftPr.mockResolvedValue({
      ok: true,
      slug: "demo-env",
      operationId: "operation-1",
      pending: true,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(globalThis, "React", { configurable: true, value: originalReact });
    vi.resetAllMocks();
  });

  it.each([
    {
      label: "create",
      initial: makeEnv(),
      button: "Create Draft PR" as const,
      terminal: makeEnv({
        updatedAt: completedPublishedAt,
        githubPublishStatus: "published",
        githubPrNumber: 42,
        githubPrUrl: "https://github.com/test/repo/pull/42",
        githubPrState: "open",
        githubLastPublishedAt: completedPublishedAt,
      }),
      toastTitle: "Draft PR #42 created",
    },
    {
      label: "update",
      initial: makeEnv({
        githubPrNumber: 42,
        githubPrUrl: "https://github.com/test/repo/pull/42",
        githubPrState: "open",
      }),
      button: "Update Draft PR" as const,
      terminal: makeEnv({
        updatedAt: completedPublishedAt,
        githubPublishStatus: "published",
        githubPrNumber: 42,
        githubPrUrl: "https://github.com/test/repo/pull/42",
        githubPrState: "open",
        githubLastPublishedAt: completedPublishedAt,
      }),
      toastTitle: "Draft PR #42 updated",
    },
  ])("confirms a matching $label operation before returning to the environment", async ({ initial, button, terminal, toastTitle }) => {
    const onRecoverEntities = vi.fn();
    const view = renderShip(initial, { onRecoverEntities });

    await acceptPublish(button);
    expect(onRecoverEntities).toHaveBeenCalledWith({ slug: "demo-env", repoId: "repo-1" });

    await act(async () => view.rerender(
      <ShipView env={publishingEnv()} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => view.rerender(
      <ShipView env={terminal} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));

    expect(mocks.addToast).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).toHaveBeenCalledWith({ title: toastTitle, variant: "success" });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith("/envs/demo-env", { replace: true });

    await act(async () => view.rerender(
      <ShipView env={{ ...terminal }} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));
    expect(mocks.addToast).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it("ignores terminal, unrelated, and stale updates until the accepted operation completes", async () => {
    const view = renderShip(makeEnv());
    await acceptPublish();

    await act(async () => view.rerender(
      <ShipView
        env={makeEnv({ githubPublishStatus: "published", githubLastPublishedAt: completedPublishedAt })}
        repo={makeRepo()}
        hubUrl="https://hub.test"
      />,
    ));
    await act(async () => view.rerender(
      <ShipView env={publishingEnv("another-operation")} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => view.rerender(
      <ShipView env={publishingEnv()} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));
    await act(async () => view.rerender(
      <ShipView
        env={makeEnv({ githubPublishStatus: "published", githubLastPublishedAt: previousPublishedAt })}
        repo={makeRepo()}
        hubUrl="https://hub.test"
      />,
    ));
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => view.rerender(
      <ShipView
        env={makeEnv({ githubPublishStatus: "published", githubLastPublishedAt: completedPublishedAt })}
        repo={makeRepo()}
        hubUrl="https://hub.test"
      />,
    ));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it("stays on Ship and preserves failure feedback", async () => {
    const view = renderShip(makeEnv());
    await acceptPublish();
    await act(async () => view.rerender(
      <ShipView env={publishingEnv()} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));
    await act(async () => view.rerender(
      <ShipView
        env={makeEnv({
          githubPublishStatus: "failed",
          githubPublishError: "GitHub rejected the branch update.",
        })}
        repo={makeRepo()}
        hubUrl="https://hub.test"
      />,
    ));

    expect(screen.getByText("GitHub rejected the branch update.")).toBeInTheDocument();
    expect(screen.queryByText(/conflicts or unsupported git state/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Draft PR" })).toBeEnabled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows neutral feedback and stays on Ship when the request has no changes", async () => {
    mocks.publishEnvDraftPr.mockResolvedValue({
      ok: true,
      slug: "demo-env",
      noChanges: true,
    });
    const onRecoverEnv = vi.fn();
    const onRecoverEntities = vi.fn();
    renderShip(makeEnv(), { onRecoverEnv, onRecoverEntities });

    await acceptPublish();

    expect(mocks.addToast).toHaveBeenCalledWith({ title: "No changes to publish", variant: "info" });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(onRecoverEnv).toHaveBeenCalledWith("demo-env");
    expect(onRecoverEntities).toHaveBeenCalledWith({ slug: "demo-env", repoId: "repo-1" });
  });

  it("disambiguates duplicate display names in reset confirmation and resets by slug", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const onRecoverEnv = vi.fn();
    const onRecoverEntities = vi.fn();
    renderShip(makeEnv({ displayName: "Shared plan" }), {
      onRecoverEnv,
      onRecoverEntities,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Reset to Main" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Reset "Shared plan" (slug: demo-env) to the GitHub default branch? This will discard unpublished changes.',
    );
    await waitFor(() => expect(mocks.resetEnvToRepo).toHaveBeenCalledWith(
      "https://hub.test",
      "demo-env",
    ));
    expect(onRecoverEnv).toHaveBeenCalledWith("demo-env");
    expect(onRecoverEntities).toHaveBeenCalledWith({ slug: "demo-env", repoId: "repo-1" });
    confirmSpy.mockRestore();
  });

  it("treats an accepted operation that finishes up-to-date as no changes", async () => {
    const view = renderShip(makeEnv());
    await acceptPublish();
    await act(async () => view.rerender(
      <ShipView env={publishingEnv()} repo={makeRepo()} hubUrl="https://hub.test" />,
    ));
    await act(async () => view.rerender(
      <ShipView
        env={makeEnv({ githubPublishStatus: "up-to-date", workspaceDirty: false, branchStatus: "up-to-date" })}
        repo={makeRepo()}
        hubUrl="https://hub.test"
      />,
    ));

    expect(mocks.addToast).toHaveBeenCalledWith({ title: "No changes to publish", variant: "info" });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
