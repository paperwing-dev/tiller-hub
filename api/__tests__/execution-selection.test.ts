import { describe, expect, it } from "vitest";
import {
  deriveExecutionStatus,
  parseLegacyCustomDomainCleanupManifest,
  parseExecutionSelection,
  parseSetExecutionBackendRequest,
  selectionToPlacement,
} from "../execution";
import { isExecutionPlacement } from "../types";

describe("execution selection", () => {
  it("parses only the exact versioned selection shapes", () => {
    expect(parseExecutionSelection({ target: "cf" })).toEqual({ target: "cf" });
    expect(parseExecutionSelection({ target: "host", machineId: " machine-1 " }))
      .toEqual({ target: "host", machineId: "machine-1" });
    expect(parseExecutionSelection({ target: "cf", machineId: null })).toBeNull();
    expect(parseExecutionSelection({ target: "host", machineId: "" })).toBeNull();
    expect(parseExecutionSelection({ target: "host", machineId: "one", fallback: "cf" })).toBeNull();
  });

  it("produces exact sticky placements", () => {
    expect(selectionToPlacement({ target: "cf" })).toEqual({
      backend: "cf",
      machineId: null,
    });
    expect(selectionToPlacement({ target: "host", machineId: "machine-1" })).toEqual({
      backend: "host",
      machineId: "machine-1",
    });
    expect(isExecutionPlacement({ backend: "host", machineId: null })).toBe(false);
    expect(isExecutionPlacement({ backend: "cf", machineId: "machine-1" })).toBe(false);
  });

  it("distinguishes a selected offline machine from the live candidate", () => {
    expect(deriveExecutionStatus({
      selected: { target: "host", machineId: "old-machine" },
      selectedDisplayName: "Old machine",
      candidate: {
        state: "ready",
        machineId: "new-machine",
        displayName: "New machine",
      },
    })).toEqual({
      selected: { target: "host", machineId: "old-machine" },
      selectedHost: {
        state: "offline",
        machineId: "old-machine",
        displayName: "Old machine",
      },
      candidate: {
        state: "ready",
        machineId: "new-machine",
        displayName: "New machine",
      },
      executionReady: false,
    });
  });

  it("uses expectedMachineId as an exact concurrency precondition", () => {
    expect(parseSetExecutionBackendRequest({ target: "cf" })).toEqual({ target: "cf" });
    expect(parseSetExecutionBackendRequest({
      target: "host",
      expectedMachineId: " machine-1 ",
    })).toEqual({ target: "host", expectedMachineId: "machine-1" });
    expect(parseSetExecutionBackendRequest({
      target: "host",
      expectedMachineId: "machine-1",
      machineId: "machine-2",
    })).toBeNull();
  });

  it("accepts only the exact secret-free cleanup manifest shape", () => {
    const manifest = {
      version: 1,
      capturedAt: "2026-07-17T12:00:00.000Z",
      customHostname: "tiller.example.com",
      workerService: "tiller",
      accountId: "account-1",
      zoneId: "zone-1",
      customDomainId: "domain-1",
      accessApplicationId: "app-1",
      accessPolicyIds: ["browser-policy", "service-policy"],
    };
    expect(parseLegacyCustomDomainCleanupManifest(manifest)).toEqual(manifest);
    expect(parseLegacyCustomDomainCleanupManifest({
      ...manifest,
      clientSecret: "secret",
    })).toBeNull();
    expect(parseLegacyCustomDomainCleanupManifest({
      ...manifest,
      accessPolicyIds: ["duplicate", "duplicate"],
    })).toBeNull();
  });
});
