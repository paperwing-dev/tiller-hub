import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta } from "../../types";
import { createInitialEnvScmState } from "../model";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  ensureRepoWorkspaceFromRepoUrl: vi.fn(),
  getScmOperationStore: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
}));

vi.mock("../../plan/store", () => ({
  ensureRepoWorkspaceFromRepoUrl: mocks.ensureRepoWorkspaceFromRepoUrl,
}));

vi.mock("../operation-store", () => ({
  getScmOperationStore: mocks.getScmOperationStore,
}));

const { clearScmOperationState, reconcileEnvScmOperationState } = await import("../env-state");

function makeMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    backend: "cf",
    harness: "claude-code",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    status: "stopped",
    ...createInitialEnvScmState({
      slug: "demo-env",
      mainCommit: "main-a",
    }),
    ...overrides,
  };
}

describe("scm/env-state", () => {
  beforeEach(() => {
    mocks.getEnvLifecycleStub.mockReset();
    mocks.ensureRepoWorkspaceFromRepoUrl.mockReset();
    mocks.getScmOperationStore.mockReset();
  });

  it("leaves env summaries without scm operations unchanged", async () => {
    const meta = makeMeta({ scmOperationType: null, scmOperationId: null });

    await expect(
      reconcileEnvScmOperationState({} as any, meta, async () => meta),
    ).resolves.toEqual(meta);
    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
    expect(mocks.getScmOperationStore).not.toHaveBeenCalled();
  });

  it("clears stale scm projections when the authoritative operation is gone", async () => {
    const lifecycleStub = {
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue({
      getOperation: vi.fn().mockResolvedValue(null),
    });

    const meta = makeMeta({
      scmOperationType: "merge-into-main",
      scmOperationId: "op-stale",
      scmOperationPhase: "Starting sandbox",
      scmOperationUpdatedAt: "2026-04-13T00:01:00.000Z",
    });
    const persisted = clearScmOperationState(meta, {
      completedAt: meta.scmOperationUpdatedAt,
    });

    await expect(
      reconcileEnvScmOperationState({} as any, meta, async () => persisted),
    ).resolves.toEqual(persisted);
    expect(lifecycleStub.clearScmProjection).toHaveBeenCalledWith({
      completedAt: "2026-04-13T00:01:00.000Z",
    });
  });
});
