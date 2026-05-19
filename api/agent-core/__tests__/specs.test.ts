import { describe, expect, it } from "vitest";
import { getAgentSpec, listHostedAgentMetadata } from "../specs";

describe("getAgentSpec", () => {
  it("returns the plan spec with a direct-tools runtime", () => {
    const spec = getAgentSpec("plan");

    expect(spec.name).toBe("plan");
    expect(spec.runtime).toBe("direct-tools");
    expect(spec.modelTarget.provider).toBe("external-codex");
    expect(spec.modelTarget.defaultModel).toBe("gpt-5.4");
    expect(spec.toolNames).toEqual([
      "read_file",
      "write_file",
      "list_files",
      "glob",
      "save_memory",
      "recall_memory",
      "save_artifact",
      "read_artifact",
      "list_artifacts",
    ]);
    expect(spec.baseInstructions).not.toContain("save_handoff");
  });

  it("returns the planner spec with a direct-tools runtime", () => {
    const spec = getAgentSpec("planner");

    expect(spec.name).toBe("planner");
    expect(spec.runtime).toBe("direct-tools");
    expect(spec.modelTarget.provider).toBe("workers-ai");
    expect(spec.modelTarget.defaultModel).toBe("@cf/nvidia/nemotron-3-120b-a12b");
    expect(spec.toolNames).toEqual([
      "read_file",
      "write_file",
      "list_files",
      "glob",
      "recall_memory",
    ]);
    expect(spec.baseInstructions).not.toContain("handoff");
  });

  it("returns the reviewer spec with a Workers AI model target", () => {
    const spec = getAgentSpec("reviewer");

    expect(spec.name).toBe("reviewer");
    expect(spec.runtime).toBe("direct-tools");
    expect(spec.modelTarget.provider).toBe("workers-ai");
    expect(spec.modelTarget.defaultModel).toBe("@cf/moonshotai/kimi-k2.5");
    expect(spec.toolNames).toEqual(["read_file", "list_files", "glob", "recall_memory"]);
  });

  it("returns the cartographer spec with a codemode runtime", () => {
    const spec = getAgentSpec("cartographer");

    expect(spec.name).toBe("cartographer");
    expect(spec.runtime).toBe("codemode");
    expect(spec.modelTarget.provider).toBe("workers-ai");
    expect(spec.toolNames).toEqual([
      "read_file",
      "list_files",
      "glob",
      "recall_memory",
    ]);
    expect(spec.baseInstructions).not.toContain("save_handoff");
  });
});

describe("listHostedAgentMetadata", () => {
  it("returns hosted agent metadata with resolved models", () => {
    const metadata = listHostedAgentMetadata({
      OPENAI_MODEL: "gpt-5.5-preview",
    } as any);

    expect(metadata).toEqual([
      {
        id: "plan-chat",
        name: "plan",
        label: "Plan",
        runtime: "direct-tools",
        provider: "external-codex",
        model: "gpt-5.4",
      },
      {
        id: "research-chat",
        name: "research",
        label: "Research",
        runtime: "direct-tools",
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
      },
      {
        id: "planner-chat",
        name: "planner",
        label: "Planner",
        runtime: "direct-tools",
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
      },
      {
        id: "cartographer-chat",
        name: "cartographer",
        label: "Cartographer",
        runtime: "codemode",
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
      },
      {
        id: "reviewer-chat",
        name: "reviewer",
        label: "Reviewer",
        runtime: "direct-tools",
        provider: "workers-ai",
        model: "@cf/moonshotai/kimi-k2.5",
      },
    ]);
  });
});
