import { describe, expect, it } from "vitest";
import { getAgentSpec, listHostedAgentMetadata } from "../specs";

describe("getAgentSpec", () => {
  it("returns the plan spec with a Think runtime", () => {
    const spec = getAgentSpec("plan");

    expect(spec.name).toBe("plan");
    expect(spec.runtime).toBe("think");
    expect(spec.modelTarget.provider).toBe("external-codex");
    expect(spec.modelTarget.defaultModel).toBe("gpt-5.5");
    expect(spec.toolNames).toEqual([
      "read_artifact",
      "list_artifacts",
      "save_plan",
    ]);
    expect(spec.baseInstructions).toContain("Provider-neutral planner runs");
    expect(spec.includeProjectContext).toBeUndefined();
    expect(spec.includeMemories).toBeUndefined();
    expect(spec.injectWorkspaceSummary).toBeUndefined();
    expect(spec.maxContextChars).toBeUndefined();
    expect(spec.maxRecentArtifacts).toBe(6);
  });

  it("returns the reviewer spec with a Workers AI model target", () => {
    const spec = getAgentSpec("reviewer");

    expect(spec.name).toBe("reviewer");
    expect(spec.runtime).toBe("direct-tools");
    expect(spec.modelTarget.provider).toBe("workers-ai");
    expect(spec.modelTarget.defaultModel).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(spec.toolNames).toEqual(["read_file", "list_files", "glob", "recall_memory"]);
  });

  it("rejects removed hosted agent specs", () => {
    expect(() => getAgentSpec("research")).toThrow("Unknown agent: research");
    expect(() => getAgentSpec("cartographer")).toThrow("Unknown agent: cartographer");
  });
});

describe("listHostedAgentMetadata", () => {
  it("returns hosted agent metadata with resolved models", () => {
    const metadata = listHostedAgentMetadata({
      OPENAI_MODEL: "gpt-5.5-preview",
    } as any);

    expect(metadata).toEqual([
      {
        id: "reviewer-chat",
        name: "reviewer",
        label: "Reviewer",
        runtime: "direct-tools",
        provider: "workers-ai",
        model: "@cf/moonshotai/kimi-k2.7-code",
      },
    ]);
  });
});
