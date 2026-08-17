import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArtifactStoreStub: vi.fn(),
  loadTrackedRepo: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
}));

vi.mock("../../repo/access", () => ({
  loadTrackedRepo: mocks.loadTrackedRepo,
}));

const { ensureRepoEnvironmentSidebarSlots } = await import("../sidebar-slots");

describe("environment sidebar-slot reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadTrackedRepo.mockResolvedValue({
      ok: true,
      repo: { meta: { artifactStoreGeneration: null } },
    });
  });

  it("repairs the current slot without rewriting the immutable display name", async () => {
    const definition = {
      slug: "env-1",
      displayName: "Scratch #1",
      incarnationId: "incarnation-1",
      sidebarSlot: 1,
      repoId: "repo-1",
      scmModel: "github",
      executionPlacement: { backend: "cf", machineId: null },
      harness: "claude-code",
      startupPlanId: null,
      branchName: "tiller/env/env-1",
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    const rows = new Map([["envdef:env-1", JSON.stringify(definition)]]);
    const env = {
      ENVS_KV: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: "envdef:env-1" }],
          list_complete: true,
        }),
        get: vi.fn(async (key: string) => rows.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => rows.set(key, value)),
      },
    } as any;
    mocks.getArtifactStoreStub.mockReturnValue({
      reconcileEnvironmentSidebarSlots: vi.fn().mockResolvedValue([
        { slug: "env-1", slot: 5 },
      ]),
    });

    await ensureRepoEnvironmentSidebarSlots(env, "repo-1");

    expect(JSON.parse(rows.get("envdef:env-1")!)).toMatchObject({
      displayName: "Scratch #1",
      sidebarSlot: 5,
    });
  });
});
