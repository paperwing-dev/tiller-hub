import { describe, expect, it } from "vitest";
import {
  mergeMachineServiceState,
  parseMachineServiceState,
} from "../machine-service-state";

describe("machine service state helpers", () => {
  it("merges host state", () => {
    const current = parseMachineServiceState({
      host: {
        machineId: "host-1",
        displayName: "old-host",
        connectedAt: "2026-04-07T00:00:00.000Z",
        dockerAvailable: true,
        runnerAvailable: true,
        claudeSubscription: true,
        transport: "session",
      },
    });

    expect(
      mergeMachineServiceState(current, {
        host: {
          machineId: "host-2",
          displayName: "new-host",
          connectedAt: "2026-04-07T00:01:00.000Z",
          runnerCommandProtocol: 1,
          codexRuntimeAuthProtocol: 1,
          reviewerIsolationProtocol: 1,
          dockerAvailable: true,
          runnerAvailable: true,
          claudeSubscription: false,
          localRunnerImage: " docker.io/jamieatlason/tiller-sandbox:0123456789abcdef0123456789abcdef01234567 ",
          localRunnerImageSourceId: " 0123456789abcdef0123456789abcdef01234567 ",
          transport: "session",
        },
      }),
    ).toEqual({
      host: {
        machineId: "host-2",
        displayName: "new-host",
        connectedAt: "2026-04-07T00:01:00.000Z",
        runnerCommandProtocol: 1,
        codexRuntimeAuthProtocol: 1,
        reviewerIsolationProtocol: 1,
        dockerAvailable: true,
        runnerAvailable: true,
        claudeSubscription: false,
        localRunnerImage: "docker.io/jamieatlason/tiller-sandbox:0123456789abcdef0123456789abcdef01234567",
        localRunnerImageSourceId: "0123456789abcdef0123456789abcdef01234567",
        transport: "session",
      },
    });
  });

  it("accepts only known runtime protocol capabilities", () => {
    const parsed = parseMachineServiceState({
      host: {
        machineId: "host-1",
        displayName: "host-1",
        connectedAt: "2026-04-07T00:00:00.000Z",
        runnerCommandProtocol: 2,
        reviewerIsolationProtocol: 2,
        dockerAvailable: true,
        runnerAvailable: true,
        claudeSubscription: true,
        transport: "session",
      },
    });
    expect(parsed.host?.runnerCommandProtocol).toBeUndefined();
    expect(parsed.host?.reviewerIsolationProtocol).toBeUndefined();
  });
});
