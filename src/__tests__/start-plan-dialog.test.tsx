/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "../../api/coordination/types";
import type { EnvMeta } from "../../api/types";
import StartPlanDialog from "../StartPlanDialog";

const mocks = vi.hoisted(() => ({
  fetchRepoArtifacts: vi.fn(),
  startEnv: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchRepoArtifacts: mocks.fetchRepoArtifacts,
  startEnv: mocks.startEnv,
}));

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
    branchStatus: "up-to-date",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: null,
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

function makePlan(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "plan-1",
    repoId: "repo-1",
    type: "plan",
    basis: { repoId: "repo-1", mainCommit: "main-a" },
    title: "Specific saved plan",
    body: { markdown: "Do the work." },
    status: "draft",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("StartPlanDialog", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.fetchRepoArtifacts.mockReset();
    mocks.startEnv.mockReset();
    mocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [makePlan()],
      refs: [],
    });
    mocks.startEnv.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    root = null;
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  it("defaults to no plan and removes the old plan shortcut wording", async () => {
    await act(async () => {
      root?.render(
        <StartPlanDialog
          env={makeEnv()}
          repoMainCommit="main-a"
          hubUrl="https://hub.test"
          onClose={() => undefined}
          onStarted={() => undefined}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const text = container.textContent ?? "";
    expect(text).not.toContain("Latest");
    expect(text).not.toContain("current-main");
    expect(text.indexOf("No plan")).toBeLessThan(text.indexOf("Choose specific plan"));

    const noPlanRadio = container.querySelector<HTMLInputElement>('input[type="radio"]');
    expect(noPlanRadio?.checked).toBe(true);

    const startButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Start");
    expect(startButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.startEnv).toHaveBeenCalledWith(
      "https://hub.test",
      "demo-env",
      { planSelection: { mode: "none" } },
    );
  });
});
