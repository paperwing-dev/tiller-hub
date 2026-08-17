import { describe, expect, it } from "vitest";
import type { EnvMeta } from "../../api/types";
import type { PlanArtifact } from "../../api/coordination/types";
import {
  implementationDisplayName,
  implementationExecutionLocation,
  implementationHasUnreadUpdate,
  implementationHasShipTarget,
  implementationRuntime,
} from "../ImplementationsSidebar";

describe("implementationRuntime", () => {
  it("includes the configured model effort in hover-card metadata", () => {
    const env = {
      backend: "cf",
      harness: "codex",
      harnessSettings: {
        model: "gpt-5.6-sol",
        effort: "xhigh",
      },
    } as EnvMeta;

    expect(implementationRuntime(env)).toBe(
      "Codex · GPT-5.6 Sol · Extra High effort",
    );
  });

  it("keeps the execution location out of the runtime row", () => {
    expect(implementationExecutionLocation("cf")).toBe("Cloudflare Containers");
    expect(implementationExecutionLocation("host")).toBe("Your machine");
  });

  it("uses the plan title instead of the environment slug", () => {
    const env = {
      slug: "tiller-cf-2",
      startupPlanId: "plan-1",
    } as EnvMeta;
    const plan = {
      id: "plan-1",
      title: "Repo-Scoped Plan Tools for Scribes",
    } as PlanArtifact;

    expect(implementationDisplayName(env, [plan])).toBe(
      "Repo-Scoped Plan Tools for Scribes",
    );
  });

  it("uses a neutral name while a linked plan is still loading", () => {
    const env = {
      slug: "tiller-cf-2",
      startupPlanId: "plan-1",
    } as EnvMeta;

    expect(implementationDisplayName(env, [])).toBe("Implementation");
  });

  it("recognizes saved changes and existing pull requests as ship targets", () => {
    expect(implementationHasShipTarget({ workspaceDirty: true } as EnvMeta)).toBe(true);
    expect(implementationHasShipTarget({ githubPrUrl: "https://github.test/pr/1" } as EnvMeta)).toBe(true);
    expect(implementationHasShipTarget({ workspaceDirty: false } as EnvMeta)).toBe(false);
  });

  it("recognizes an unread implementor completion as a waiting update", () => {
    expect(implementationHasUnreadUpdate({ implementorAttentionToken: "attention-1" } as EnvMeta)).toBe(true);
    expect(implementationHasUnreadUpdate({ implementorAttentionToken: null } as EnvMeta)).toBe(false);
  });
});
