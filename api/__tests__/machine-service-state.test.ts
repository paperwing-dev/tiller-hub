import { describe, expect, it } from "vitest";
import {
  clearMachineServiceKeys,
  mergeMachineServiceState,
  parseMachineServiceState,
} from "../machine-service-state";

describe("machine service state helpers", () => {
  it("merges host state", () => {
    const current = parseMachineServiceState({
      host: {
        machineId: "host-1",
        connectedAt: "2026-04-07T00:00:00.000Z",
        dockerAvailable: true,
        codexSubscription: false,
        claudeSubscription: true,
        gatewayPort: 8777,
        transport: "session",
      },
    });

    expect(
      mergeMachineServiceState(current, {
        host: {
          machineId: "host-2",
          connectedAt: "2026-04-07T00:01:00.000Z",
          dockerAvailable: true,
          codexSubscription: true,
          codexGatewayAuth: "session-token",
          claudeSubscription: false,
          gatewayPort: 8788,
          gatewayUrl: "https://gateway.example.com",
          gatewayTunnelType: "named",
          transport: "session",
        },
      }),
    ).toEqual({
      host: {
        machineId: "host-2",
        connectedAt: "2026-04-07T00:01:00.000Z",
        dockerAvailable: true,
        codexSubscription: true,
        codexGatewayAuth: "session-token",
        claudeSubscription: false,
        gatewayPort: 8788,
        gatewayUrl: "https://gateway.example.com",
        gatewayTunnelType: "named",
        transport: "session",
      },
    });
  });

  it("parses invalid legacy service keys as empty", () => {
    expect(
      parseMachineServiceState({
        runner: {
          machineId: "runner-1",
          connectedAt: "2026-04-07T00:00:00.000Z",
        },
        gateway: {
          connectedAt: "2026-04-07T00:00:00.000Z",
        },
      }),
    ).toEqual({});
  });

  it("drops legacy runner ingress fields from host state", () => {
    expect(
      parseMachineServiceState({
        host: {
          machineId: "host-1",
          connectedAt: "2026-04-07T00:00:00.000Z",
          dockerAvailable: true,
          codexSubscription: true,
          claudeSubscription: false,
          gatewayPort: 8788,
          gatewayUrl: "https://gateway.example.com",
          gatewayTunnelType: "named",
          runnerIngressUrl: "https://runner.example.com",
          transport: "session",
        },
      }),
    ).toEqual({
      host: {
        machineId: "host-1",
        connectedAt: "2026-04-07T00:00:00.000Z",
        dockerAvailable: true,
        codexSubscription: true,
        claudeSubscription: false,
        gatewayPort: 8788,
        gatewayUrl: "https://gateway.example.com",
        gatewayTunnelType: "named",
        transport: "session",
      },
    });
  });

  it("clears the host service key", () => {
    expect(
      clearMachineServiceKeys(
        parseMachineServiceState({
          host: {
            machineId: "host-1",
            connectedAt: "2026-04-07T00:01:00.000Z",
            dockerAvailable: true,
            codexSubscription: true,
            claudeSubscription: true,
            gatewayPort: 8788,
            transport: "session",
          },
        }),
        ["host"],
      ),
    ).toEqual({});
  });
});
