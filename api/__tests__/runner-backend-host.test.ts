import { describe, expect, it, vi } from "vitest";
import { createHostRunnerBackend } from "../env/runner-backend-host";
import {
  getRunnerControlErrorCode,
  getRunnerCurrentCommandGeneration,
} from "../env/runner-backend";

function createEnv(error: Error, requestLocalRunner = vi.fn().mockRejectedValue(error)) {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        requestLocalRunner,
      })),
    },
  } as any;
}

const meta = {
  slug: "demo-env",
  repoUrl: "https://github.com/test/repo",
  repoId: "repo-1",
  backend: "host",
  executionPlacement: { backend: "host", machineId: "machine-1" },
  harness: "codex",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "stopped",
} as any;

const absentCommand = {
  commandGeneration: 9,
  operationId: "destroy-op-9",
  desiredState: "absent" as const,
};

describe("host runner inspection", () => {
  it.each([
    ["running", "live"],
    ["stopped", "stopped"],
    ["exited", "stopped"],
  ] as const)("classifies a fresh %s response as %s", async (status, state) => {
    const requestLocalRunner = vi.fn().mockResolvedValue({
      machineId: "machine-1",
      result: { status },
    });
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    await expect(backend.inspect!(meta)).resolves.toEqual({ state, status });
    expect(requestLocalRunner).toHaveBeenCalledWith("machine-1", "status", "demo-env", {});
  });

  it("accepts only typed runner-not-found as fresh absence proof", async () => {
    const typed = Object.assign(new Error("Runner is absent"), { code: "runner_not_found" });
    const absentBackend = await createHostRunnerBackend(createEnv(typed));
    const unknownBackend = await createHostRunnerBackend(createEnv(new Error("Host route returned 404")));

    await expect(absentBackend.inspect!(meta)).resolves.toEqual({
      state: "absent",
      status: "absent",
    });
    await expect(unknownBackend.inspect!(meta)).resolves.toEqual({
      state: "unknown",
      status: "unknown",
    });
  });

  it("preserves exact proof that a stopped Start failed before harness launch", async () => {
    const requestLocalRunner = vi.fn().mockResolvedValue({
      machineId: "machine-1",
      result: {
        status: "stopped",
        failedStartBeforeHarness: true,
        commandGeneration: 7,
        operationId: "start-op-7",
      },
    });
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    await expect(backend.inspect!(meta)).resolves.toEqual({
      state: "stopped",
      status: "stopped",
      safeReplacement: {
        reason: "failed_before_harness",
        commandGeneration: 7,
        operationId: "start-op-7",
      },
    });
  });
});

describe("host runner deletion", () => {
  it("accepts only a typed runner-not-found response as confirmed absence", async () => {
    const notFound = Object.assign(new Error("The assigned runner is absent."), {
      code: "runner_not_found",
    });
    const backend = await createHostRunnerBackend(createEnv(notFound));

    await expect(backend.destroy(meta, { runnerCommand: absentCommand })).resolves.toBeUndefined();
  });

  it("does not treat arbitrary 404 or not-found text as confirmed absence", async () => {
    const backend = await createHostRunnerBackend(createEnv(new Error("Host route returned 404 not found")));

    await expect(backend.destroy(meta, { runnerCommand: absentCommand })).rejects.toThrow(/Host route returned 404 not found/);
  });

  it("fails closed before dispatch when destroy has no fenced command claim", async () => {
    const requestLocalRunner = vi.fn();
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    await expect(backend.destroy(meta)).rejects.toThrow(/requires a positive command generation/i);
    expect(requestLocalRunner).not.toHaveBeenCalled();
  });

  it("preserves structured command errors for lifecycle reconciliation", async () => {
    const conflict = Object.assign(new Error("Generation already has another operation."), {
      code: "runner_command_conflict" as const,
    });
    const backend = await createHostRunnerBackend(createEnv(conflict));

    const failure = await backend.destroy(meta, { runnerCommand: absentCommand }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(getRunnerControlErrorCode(failure)).toBe("runner_command_conflict");
    expect(failure.message).toContain("Generation already has another operation");
  });

  it("rejects a success response that does not prove the fence accepted the command", async () => {
    const requestLocalRunner = vi.fn().mockResolvedValue({
      machineId: "machine-1",
      result: { removed: true },
    });
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    const failure = await backend.destroy(meta, { runnerCommand: absentCommand }).catch((error) => error);
    expect(getRunnerControlErrorCode(failure)).toBe("runner_command_conflict");
    expect(failure.message).toContain(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
  });

  it("preserves the exact existing-workload guidance when its machine is unavailable", async () => {
    const unavailable = new Error(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
    const backend = await createHostRunnerBackend(createEnv(unavailable));

    await expect(
      backend.destroy(meta, { runnerCommand: absentCommand }),
    ).rejects.toThrow(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
  });
});

describe("host runner command validation", () => {
  it("preserves the typed runner high-water through the backend wrapper", async () => {
    const rejection = Object.assign(
      new Error("Runner command generation 9 was superseded by 60."),
      {
        code: "runner_command_superseded_before_mutation" as const,
        currentCommandGeneration: 60,
      },
    );
    const backend = await createHostRunnerBackend(createEnv(rejection));

    const failure = await backend.start(meta, {}, {
      startOpId: "start-op-9",
      runnerCommand: {
        commandGeneration: 9,
        operationId: "start-op-9",
        desiredState: "running",
      },
    }).catch((error) => error);

    expect(getRunnerControlErrorCode(failure)).toBe("runner_command_superseded_before_mutation");
    expect(getRunnerCurrentCommandGeneration(failure)).toBe(60);
    expect(failure).toMatchObject({ currentCommandGeneration: 60 });
  });

  it("parses the legacy superseded message when the CLI omits typed high-water metadata", async () => {
    const rejection = Object.assign(
      new Error("Execution machine start failed: Runner command generation 9 was superseded by 60."),
      { code: "runner_command_superseded_before_mutation" as const },
    );
    const backend = await createHostRunnerBackend(createEnv(rejection));

    const failure = await backend.start(meta, {}, {
      startOpId: "start-op-9",
      runnerCommand: {
        commandGeneration: 9,
        operationId: "start-op-9",
        desiredState: "running",
      },
    }).catch((error) => error);

    expect(getRunnerCurrentCommandGeneration(failure)).toBe(60);
  });

  it("rejects invalid typed high-water metadata through the backend wrapper", async () => {
    const rejection = Object.assign(
      new Error("Runner command generation 9 was superseded by 60."),
      {
        code: "runner_command_superseded_before_mutation" as const,
        currentCommandGeneration: Number.MAX_SAFE_INTEGER + 1,
      },
    );
    const backend = await createHostRunnerBackend(createEnv(rejection));
    const failure = await backend.start(meta, {}, {
      startOpId: "start-op-9",
      runnerCommand: {
        commandGeneration: 9,
        operationId: "start-op-9",
        desiredState: "running",
      },
    }).catch((error) => error);

    expect(getRunnerCurrentCommandGeneration(failure)).toBeNull();
  });

  it("rejects a mismatched callback operation id before Start dispatch", async () => {
    const requestLocalRunner = vi.fn();
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    await expect(backend.start(meta, {}, {
      startOpId: "start-op-a",
      runnerCommand: {
        commandGeneration: 10,
        operationId: "start-op-b",
        desiredState: "running",
      },
    })).rejects.toThrow(/must match the runner command operation ID/i);
    expect(requestLocalRunner).not.toHaveBeenCalled();
  });

  it("rejects an action-incompatible desired state before Stop dispatch", async () => {
    const requestLocalRunner = vi.fn();
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    await expect(backend.stop(meta, {
      stopOpId: "stop-op",
      runnerCommand: {
        commandGeneration: 11,
        operationId: "stop-op",
        desiredState: "running",
      },
    })).rejects.toThrow(/requires a positive command generation/i);
    expect(requestLocalRunner).not.toHaveBeenCalled();
  });

  it("propagates exact pre-workspace Start rejection proof from the machine runner", async () => {
    const runnerCommand = {
      commandGeneration: 12,
      operationId: "stop-op-12",
      desiredState: "stopped" as const,
    };
    const requestLocalRunner = vi.fn().mockResolvedValue({
      machineId: "machine-1",
      result: {
        status: "stopped",
        callbackExpected: false,
        startRejectedBeforeWorkspace: true,
        ...runnerCommand,
      },
    });
    const backend = await createHostRunnerBackend(createEnv(new Error("unused"), requestLocalRunner));

    await expect(backend.stop(meta, {
      stopOpId: runnerCommand.operationId,
      runnerCommand,
    })).resolves.toEqual({
      callbackExpected: false,
      startRejectedBeforeWorkspace: true,
    });
  });
});
