import { describe, expect, it } from "vitest";
import { buildOptions, buildReviewerModelOptions } from "../AddReviewerMenu";
import type { PlannerProviderMetadata } from "../api";

describe("buildOptions", () => {
  it("shows reviewer chat models without planning skill actions", () => {
    const options = buildOptions([
      provider({
        id: "codex",
        displayName: "Codex",
        reviewer: false,
        models: [model("gpt-5.5", "GPT 5.5")],
      }),
      provider({
        id: "claude-code",
        displayName: "Claude Code",
        models: [
          model("sonnet", "Claude Sonnet 4.6"),
          model("opus", "Claude Opus 4.8"),
        ],
      }),
      provider({
        id: "opencode",
        displayName: "OpenCode",
        models: [model("@cf/moonshotai/kimi-k2.7-code", "Kimi K2.7 Code")],
      }),
    ]);

    expect(options.map((option) => option.label)).toEqual([
      "Claude Sonnet 4.6 chat",
      "Claude Opus 4.8 chat",
      "Kimi K2.7 Code chat",
    ]);
    expect(options.some((option) => option.label.includes("·"))).toBe(false);
    expect(options.every((option) => option.input.kind === "tab")).toBe(true);
    expect(options.every((option) => option.input.effort === "high")).toBe(true);
  });

  it("uses the selected model's full effort options", () => {
    const options = buildReviewerModelOptions([
      {
        ...provider({
          id: "codex",
          displayName: "Codex",
          models: [{
            ...model("gpt-5.6-sol", "GPT-5.6 Sol"),
            efforts: [
              { id: "low", displayName: "Low" },
              { id: "xhigh", displayName: "Extra High" },
              { id: "max", displayName: "Max" },
              { id: "ultra", displayName: "Ultra" },
            ],
            defaultEffort: "xhigh",
          }],
        }),
        efforts: [
          { id: "low", displayName: "Low" },
          { id: "xhigh", displayName: "Extra High" },
        ],
        defaultEffort: "xhigh",
      },
    ]);

    expect(options).toMatchObject([{
      label: "GPT-5.6 Sol",
      description: "Codex",
      defaultEffort: "xhigh",
      efforts: [
        { value: "low", label: "Low" },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
        { value: "ultra", label: "Ultra" },
      ],
    }]);
  });
});

function provider(options: {
  id: string;
  displayName: string;
  reviewer?: boolean;
  available?: boolean;
  models: PlannerProviderMetadata["models"];
}): PlannerProviderMetadata {
  return {
    id: options.id,
    displayName: options.displayName,
    available: options.available ?? true,
    authStatus: "available",
    disabledReasons: [],
    capabilities: {
      writer: true,
      reviewer: options.reviewer ?? true,
      chatContinuation: true,
      cancellation: true,
      planDelta: false,
      checklist: false,
    },
    models: options.models,
    efforts: [{ id: "high", displayName: "High" }],
    defaultEffort: "high",
  };
}

function model(id: string, displayName: string): PlannerProviderMetadata["models"][number] {
  return {
    id,
    displayName,
    available: true,
    authStatus: "available",
  };
}
