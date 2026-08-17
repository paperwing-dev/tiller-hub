import { describe, expect, it } from "vitest";
import {
  resolveCodexBackendReadiness,
  resolveCodexExecution,
  type ResolveCodexExecutionInput,
} from "../codex-execution";

const targets = [
  { backend: "cf" },
  { backend: "host" },
] as const;

describe("resolveCodexExecution", () => {
  it.each(targets)("uses subscription app-server for $backend", (target) => {
    for (const subscriptionStatus of ["connected", "refreshing"] as const) {
      for (const surface of ["implementor", "plan-writer", "plan-reviewer", "environment-reviewer"] as const) {
        expect(resolveCodexExecution({
          ...target,
          surface,
          authPreference: "subscription",
          subscriptionStatus,
          apiKeyAvailable: true,
        })).toEqual({
          kind: "ready",
          profile: { ...target, kind: "subscription-app-server", surface },
        });
      }
    }
  });

  it.each(targets)("uses the surface-appropriate API profile for $backend", (target) => {
    expect(resolveCodexExecution({
      ...target,
      surface: "plan-writer",
      authPreference: "api-key",
      subscriptionStatus: "connected",
      apiKeyAvailable: true,
    })).toMatchObject({ kind: "ready", profile: { kind: "api-key-app-server", ...target } });
    expect(resolveCodexExecution({
      ...target,
      surface: "implementor",
      authPreference: "api-key",
      subscriptionStatus: "connected",
      apiKeyAvailable: true,
    })).toMatchObject({ kind: "ready", profile: { kind: "api-key-app-server", ...target } });

    expect(resolveCodexExecution({
      ...target,
      surface: "plan-reviewer",
      authPreference: "api-key",
      subscriptionStatus: "connected",
      apiKeyAvailable: true,
    })).toMatchObject({ kind: "ready", profile: { kind: "api-key-direct-cli", ...target } });
  });

  it.each([
    ["missing", "subscription_missing"],
    ["needs_reconnect", "subscription_needs_reconnect"],
    ["temporarily_unavailable", "subscription_temporarily_unavailable"],
  ] as const)("never falls back from subscription billing for %s", (subscriptionStatus, reason) => {
    const input = {
      backend: "host",
      surface: "plan-reviewer",
      authPreference: "subscription",
      subscriptionStatus,
    } satisfies Omit<ResolveCodexExecutionInput, "apiKeyAvailable">;
    expect(resolveCodexExecution({ ...input, apiKeyAvailable: true })).toEqual({ kind: "unavailable", reason });
    expect(resolveCodexExecution({ ...input, apiKeyAvailable: false })).toEqual({ kind: "unavailable", reason });
  });
});

describe("resolveCodexBackendReadiness", () => {
  it.each([
    [{ backendConnected: false, authenticationAvailable: true }, "backend_offline"],
    [{ backendConnected: true, authenticationAvailable: true, runtimeCompatibilityRequired: true, runtimeImageCompatible: false, runtimeAuthProtocol: 1 }, "runtime_update_required"],
    [{ backendConnected: true, authenticationAvailable: true, runtimeCompatibilityRequired: true, runtimeImageCompatible: true }, "runtime_update_required"],
    [{ backendConnected: true, authenticationAvailable: true, environmentConnected: false }, "environment_not_connected"],
    [{ backendConnected: true, authenticationAvailable: false }, "authentication_unavailable"],
    [{ backendConnected: true, authenticationAvailable: true }, "available"],
    [{ backendConnected: true, authenticationAvailable: true, directApi: true }, "direct_api"],
  ] as const)("maps backend state to %s", (input, expected) => {
    expect(resolveCodexBackendReadiness(input)).toBe(expected);
  });
});
