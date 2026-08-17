import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  classifyRunnerInspection,
  isLocalOnlyRunnerBackendMode,
  runRunnerMutationWithGenerationReconciliation,
} from "../env/runner-backend";

describe("runner inspection classification", () => {
  it("keeps live, stopped, absent, and unknown states distinct", () => {
    expect(classifyRunnerInspection("running")).toEqual({ state: "live", status: "running" });
    expect(classifyRunnerInspection("exited")).toEqual({ state: "stopped", status: "exited" });
    expect(classifyRunnerInspection("not_found")).toEqual({ state: "absent", status: "not_found" });
    expect(classifyRunnerInspection("mystery")).toEqual({ state: "unknown", status: "mystery" });
  });
});

describe("isLocalOnlyRunnerBackendMode", () => {
  it("recognizes the contributor-only localhost override", () => {
    expect(
      isLocalOnlyRunnerBackendMode({ LOCAL_DEV_ONLY_BACKEND: "true" } as any),
    ).toBe(true);
    expect(
      isLocalOnlyRunnerBackendMode({ LOCAL_DEV_ONLY_BACKEND: "false" } as any),
    ).toBe(false);
  });
});

describe("runner command generation reconciliation", () => {
  const initial = {
    commandGeneration: 1,
    operationId: "start-op-1",
    desiredState: "running" as const,
  };

  it("rebases one pre-mutation rejection and retries only the mutation", async () => {
    const rejection = Object.assign(
      new Error("Runner command generation 1 was superseded by 60."),
      {
        code: "runner_command_superseded_before_mutation" as const,
        currentCommandGeneration: 60,
      },
    );
    const rebased = { ...initial, commandGeneration: 61 };
    const mutation = vi.fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce("started");
    const rebase = vi.fn().mockResolvedValue(rebased);

    await expect(runRunnerMutationWithGenerationReconciliation(initial, rebase, mutation))
      .resolves.toBe("started");
    expect(rebase).toHaveBeenCalledWith(initial, 60);
    expect(mutation).toHaveBeenNthCalledWith(1, initial);
    expect(mutation).toHaveBeenNthCalledWith(2, rebased);
  });

  it("does not reconcile missing metadata, post-mutation supersession, or a failed retry", async () => {
    const noMetadata = Object.assign(new Error("rejected"), {
      code: "runner_command_superseded_before_mutation" as const,
    });
    const postMutation = Object.assign(new Error("superseded"), {
      code: "runner_command_superseded" as const,
      currentCommandGeneration: 60,
    });
    const secondFailure = new Error("second attempt failed");
    const rebase = vi.fn().mockResolvedValue({ ...initial, commandGeneration: 61 });

    await expect(runRunnerMutationWithGenerationReconciliation(
      initial,
      rebase,
      vi.fn().mockRejectedValue(noMetadata),
    )).rejects.toBe(noMetadata);
    await expect(runRunnerMutationWithGenerationReconciliation(
      initial,
      rebase,
      vi.fn().mockRejectedValue(postMutation),
    )).rejects.toBe(postMutation);
    const mutation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("first"), {
        code: "runner_command_superseded_before_mutation" as const,
        currentCommandGeneration: 60,
      }))
      .mockRejectedValueOnce(secondFailure);
    await expect(runRunnerMutationWithGenerationReconciliation(initial, rebase, mutation))
      .rejects.toBe(secondFailure);
    expect(mutation).toHaveBeenCalledTimes(2);
  });
});
