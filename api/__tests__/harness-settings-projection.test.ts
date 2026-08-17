import { describe, expect, it } from "vitest";
import { buildEnvMetaFromLayers, buildMutableStateFromMeta } from "../env/state";
import { toStoredEnvMeta } from "../plan/store";
import { createInitialEnvScmState } from "../scm/model";
import type { EnvDefinition, EnvMeta } from "../types";

function meta(harnessSettings: EnvMeta["harnessSettings"]): EnvMeta {
  const at = "2026-07-09T00:00:00.000Z";
  return {
    slug: "demo",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "opencode",
    harnessSettings,
    createdAt: at,
    updatedAt: at,
    status: "stopped",
    implementorAttentionToken: null,
    ...createInitialEnvScmState({ slug: "demo", mainCommit: "main-sha" }),
  };
}

function definition(): EnvDefinition {
  return {
    slug: "demo",
    incarnationId: "incarnation-1",
    repoId: "repo-1",
    scmModel: "github",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "opencode",
    startupPlanId: null,
    branchName: "tiller/env/demo",
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

describe("harness settings projection", () => {
  it("projects committed settings through the normal environment view", () => {
    const input = meta({ model: "kimi-k2.7-code", effort: "high" });
    const projected = buildEnvMetaFromLayers(
      definition(),
      buildMutableStateFromMeta(input),
      input.repoUrl,
    );
    expect(projected.harnessSettings).toEqual({ model: "kimi-k2.7-code", effort: "high" });
    expect(projected.incarnationId).toBe("incarnation-1");
    expect(projected.harnessPresentation).toEqual({
      modelLabel: "Kimi K2.7 Code",
      credentialRequirement: "workers-ai",
      providerKind: "cloudflare-workers-ai",
      providerLabel: "Tiller Hub",
    });
  });

  it("projects null when no harness settings have been committed", () => {
    const input = meta(null);
    const projected = buildEnvMetaFromLayers(
      definition(),
      buildMutableStateFromMeta(input),
      input.repoUrl,
    );
    expect(projected.harnessSettings).toBeNull();
    expect(projected.harnessPresentation).toBeUndefined();
    expect(toStoredEnvMeta(projected)).not.toHaveProperty("harnessPresentation");
  });

  it("projects only the unread implementor token from private lifecycle state", () => {
    const input = meta(null);
    const mutable = buildMutableStateFromMeta(input);
    mutable.implementorAttentionState = {
      runtimeStartOpId: "start-op-1",
      lastCompletionSequence: 3,
      unreadToken: "attention-token",
    };

    const projected = buildEnvMetaFromLayers(definition(), mutable, input.repoUrl);

    expect(projected.implementorAttentionToken).toBe("attention-token");
    expect(projected).not.toHaveProperty("implementorAttentionState");
    expect(toStoredEnvMeta(projected)).toMatchObject({
      implementorAttentionToken: "attention-token",
    });
  });
});
