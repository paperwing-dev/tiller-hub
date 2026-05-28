import type { Env } from "../types";
import { resolveAgentModel } from "./models";
import type { AgentSpec, HostedAgentId, HostedAgentMetadata } from "./types";

export const PLAN_AGENT_NAME = "plan";
export const REVIEWER_AGENT_NAME = "reviewer";

const PLAN_METADATA_INSTRUCTIONS =
  "PlanChat V2 configures its cached policy and runtime tools in plan-chat-support.ts.";

export const PLAN_AGENT_SPEC: AgentSpec = {
  name: PLAN_AGENT_NAME,
  runtime: "think",
  modelTarget: {
    provider: "external-codex",
    defaultModel: "gpt-5.5",
  },
  toolNames: [
    "read_artifact",
    "list_artifacts",
    "save_plan",
  ],
  baseInstructions: PLAN_METADATA_INSTRUCTIONS,
  maxSteps: 20,
  maxRecentArtifacts: 6,
};

const REVIEWER_BASE_INSTRUCTIONS = `You are a code review assistant with read-only access to the workspace.
Inspect the relevant files before answering. Focus on bugs, risks, missing tests, and behavioral regressions.
Do not propose speculative changes unless the user asks for them explicitly.`;

export const REVIEWER_AGENT_SPEC: AgentSpec = {
  name: REVIEWER_AGENT_NAME,
  runtime: "direct-tools",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/moonshotai/kimi-k2.5",
  },
  toolNames: ["read_file", "list_files", "glob", "recall_memory"],
  baseInstructions: REVIEWER_BASE_INSTRUCTIONS,
  maxSteps: 8,
  includeProjectContext: true,
  includeMemories: true,
  includeRecentArtifacts: true,
  injectWorkspaceSummary: true,
  maxMemoryFiles: 4,
  maxRecentArtifacts: 2,
  maxContextChars: 16_000,
};

const HOSTED_AGENT_CONFIGS: Array<{
  id: HostedAgentId;
  label: string;
  spec: AgentSpec;
}> = [
  {
    id: "plan-chat",
    label: "Plan",
    spec: PLAN_AGENT_SPEC,
  },
  {
    id: "reviewer-chat",
    label: "Reviewer",
    spec: REVIEWER_AGENT_SPEC,
  },
];

export function listHostedAgentMetadata(
  env: Pick<Env, "OPENAI_MODEL">,
): HostedAgentMetadata[] {
  return HOSTED_AGENT_CONFIGS.map(({ id, label, spec }) => ({
    id,
    name: spec.name,
    label,
    runtime: spec.runtime,
    provider: spec.modelTarget.provider,
    model: resolveAgentModel(env, spec),
  }));
}

export function getAgentSpec(name?: string | null): AgentSpec {
  if (name === PLAN_AGENT_NAME) {
    return PLAN_AGENT_SPEC;
  }

  if (name === REVIEWER_AGENT_NAME) {
    return REVIEWER_AGENT_SPEC;
  }

  throw new Error(`Unknown agent: ${name}`);
}
