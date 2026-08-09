import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlanWriterModelPicker, {
  buildPlanWriterModelOptions,
  planWriterEffortLabel,
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
  });

  it("links model access settings without replacing the writer settings dialog", () => {
    const routes: AgentRoute[] = [{
      key: "codex:gpt-5.5",
      label: "GPT 5.5",
      harness: "codex",
      provider: "codex",
      model: "gpt-5.5",
      modelId: "gpt-5.5",
      supportedEfforts: ["high"],
      defaultEffort: "high",
      available: true,
    }];
    const html = renderToStaticMarkup(createElement(PlanWriterModelPicker, {
      routes,
      providers: [],
      value: { routeKey: routes[0].key, effort: "high" },
      onChange: () => undefined,
      settingsHref: "/projects/repo-1/global-settings#model-access",
    }));

    expect(html).toContain("Open model access settings");
    expect(html).toContain('href="/projects/repo-1/global-settings#model-access"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("Fast mode");
  });
});
