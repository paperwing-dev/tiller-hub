import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlannerRunStub: vi.fn(),
  getDurableObjectStub: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getPlannerRunStub: mocks.getPlannerRunStub,
}));

vi.mock("../../durable-object", () => ({
  getDurableObjectStub: mocks.getDurableObjectStub,
}));

const {
  cleanupPlanRuntimeTarget,
  destroyPlanWriterRuntime,
  executePlanRuntimeCleanupTarget,
  runnerJobCommand,
} = await import("../runtime-cleanup");

const hostPlacement = {
  backend: "host" as const,
  machineId: "machine-1",
};

const writerTarget = {
  schemaVersion: 1 as const,
  cleanupId: "cleanup-writer-1",
  kind: "writer" as const,
  repoId: "repo-1",
  planArtifactId: "plan-1",
  ownerId: "plan-writer-plan-1",
  generation: 1,
  runtime: { jobSlug: "writer-job-1", generation: 1 },
  launchProvenance: { schemaVersion: 1 as const, ...hostPlacement },
};

describe("deferred plan runtime cleanup", () => {
  const requestLocalRunner = vi.fn();
  const revokePlanWriterTerminal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDurableObjectStub.mockReturnValue({
      requestLocalRunner,
      revokePlanWriterTerminal,
      broadcastPlanWriterState: vi.fn(),
    });
  });

  it("does not accept arbitrary 404 text as proof that a host workload is absent", async () => {
    requestLocalRunner.mockRejectedValue(new Error("Host route returned 404 not found"));

    await expect(destroyPlanWriterRuntime(
      {} as any,
      writerTarget.runtime,
      hostPlacement,
    )).rejects.toThrow(/404 not found/i);
  });

  it("accepts only the typed runner-not-found outcome as confirmed absence", async () => {
    requestLocalRunner.mockRejectedValue(Object.assign(
      new Error("The assigned runner is absent"),
      { code: "runner_not_found" },
    ));

    await expect(destroyPlanWriterRuntime(
      {} as any,
      writerTarget.runtime,
      hostPlacement,
    )).resolves.toBeUndefined();
  });

  it("keeps cleanup pending when the host does not acknowledge the exact command", async () => {
    requestLocalRunner.mockResolvedValue({
      machineId: "machine-1",
      result: { status: "absent" },
    });

    await expect(destroyPlanWriterRuntime(
      {} as any,
      writerTarget.runtime,
      hostPlacement,
    )).rejects.toThrow(/exact workload cleanup command/i);
  });

  it("keeps cleanup pending when terminal revocation is not confirmed", async () => {
    revokePlanWriterTerminal.mockRejectedValue(new Error("Hub storage unavailable"));
    const artifactStore = {
      completePlanRuntimeCleanup: vi.fn(),
      recordPlanRuntimeCleanupFailure: vi.fn(),
    };

    await expect(cleanupPlanRuntimeTarget(
      {} as any,
      artifactStore as any,
      writerTarget,
    )).rejects.toThrow(/Hub storage unavailable/);
    expect(artifactStore.recordPlanRuntimeCleanupFailure).toHaveBeenCalledWith(
      writerTarget,
      "Hub storage unavailable",
    );
    expect(artifactStore.completePlanRuntimeCleanup).not.toHaveBeenCalled();
    expect(requestLocalRunner).not.toHaveBeenCalled();
  });

  it("revokes the exact generation before destroying its captured runtime", async () => {
    revokePlanWriterTerminal.mockResolvedValue(null);
    requestLocalRunner.mockResolvedValue({
      machineId: "machine-1",
      result: {
        status: "absent",
        ...runnerJobCommand("writer-job-1", "absent"),
      },
    });

    await executePlanRuntimeCleanupTarget({} as any, writerTarget);

    expect(revokePlanWriterTerminal).toHaveBeenCalledWith(
      expect.any(String),
      "repo-1",
      "plan-1",
      1,
    );
    expect(requestLocalRunner).toHaveBeenCalledWith(
      "machine-1",
      "destroy",
      "writer-job-1",
      expect.objectContaining({ desiredState: "absent" }),
    );
  });
});
