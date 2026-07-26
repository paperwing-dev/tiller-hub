import { describe, expect, it } from "vitest";
import {
  buildPlanWriterModelOptions,
  planWriterEffortLabel,
  planWriterRouteSupportsFastMode,
} from "../PlanWriterModelPicker";
import type { AgentRoute, PlannerProviderMetadata } from "../api";

describe("Plan Writer model options", () => {
  it("keeps every supported reasoning effort beside its writer model", () => {
    const providers: PlannerProviderMetadata[] = [{
      id: "codex",
      displayName: "Codex",
      available: true,
      authStatus: "available",
      disabledReasons: [],
      capabilities: {
        writer: true,
        reviewer: true,
        chatContinuation: true,
        cancellation: true,
        planDelta: false,
        checklist: false,
      },
      models: [],
      efforts: [],
      defaultEffort: "high",
    }];
    const routes: AgentRoute[] = [{
      key: "codex:gpt-5.5",
      label: "GPT 5.5",
      harness: "codex",
      provider: "codex",
      model: "gpt-5.5",
      modelId: "gpt-5.5",
      supportedEfforts: ["low", "high", "xhigh"],
      defaultEffort: "xhigh",
      available: true,
    }];

    expect(buildPlanWriterModelOptions(routes, providers)).toEqual([{
      value: "codex:gpt-5.5",
      label: "GPT 5.5",
      description: "Codex",
      disabled: false,
      disabledReason: undefined,
      efforts: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
      defaultEffort: "xhigh",
    }]);
    expect(planWriterEffortLabel("xhigh")).toBe("Extra High");
    expect(planWriterRouteSupportsFastMode(routes, "codex:gpt-5.5")).toBe(true);
    expect(planWriterRouteSupportsFastMode([
      { ...routes[0], key: "claude-code:opus", provider: "claude-code", harness: "claude-code" },
    ], "claude-code:opus")).toBe(false);
  });
});
