import type { Env } from "../types";
import { resolveAgentModel } from "./models";
import type { AgentSpec, HostedAgentId, HostedAgentMetadata } from "./types";

export const RESEARCH_AGENT_NAME = "research";
export const PLAN_AGENT_NAME = "plan";
export const PLANNER_AGENT_NAME = "planner";
export const REVIEWER_AGENT_NAME = "reviewer";
export const CARTOGRAPHER_AGENT_NAME = "cartographer";

const RESEARCH_BASE_INSTRUCTIONS = `You are a helpful coding assistant with access to a workspace of source files.
Use the available tools to read, write, and explore the codebase. Be concise and direct.
When the user asks about the code, read the relevant files first before answering.

When you create an implementation plan that should be executed by Claude Code in a container,
write it to /.tiller/plan.md using the write_file tool. This file will be automatically detected
and used as the initial prompt when the container starts.`;

export const RESEARCH_AGENT_SPEC: AgentSpec = {
  name: RESEARCH_AGENT_NAME,
  runtime: "direct-tools",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/nvidia/nemotron-3-120b-a12b",
  },
  toolNames: [
    "read_file",
    "write_file",
    "list_files",
    "glob",
    "save_memory",
    "recall_memory",
  ],
  baseInstructions: RESEARCH_BASE_INSTRUCTIONS,
  maxSteps: 25,
  includeProjectContext: true,
  includeMemories: true,
  includeRecentArtifacts: true,
  injectWorkspaceSummary: true,
  maxMemoryFiles: 6,
  maxRecentArtifacts: 3,
  maxContextChars: 20_000,
};

const PLAN_BASE_INSTRUCTIONS = `You are the primary planning assistant for this repository.
Produce concrete implementation plans, refine them after review rounds, and keep the user informed about what feedback you accepted or rejected.

When you produce or revise a concrete plan, save it as a draft artifact using save_artifact.
Use type "plan", include the selected planner model in the model field, and include repoId and mainCommit.

When the user asks you to integrate review feedback, read the relevant review artifacts first and then explain in chat what you accepted, what you rejected, and why.`;

export const PLAN_AGENT_SPEC: AgentSpec = {
  name: PLAN_AGENT_NAME,
  runtime: "direct-tools",
  modelTarget: {
    provider: "external-codex",
    defaultModel: "gpt-5.4",
  },
  toolNames: [
    "read_file",
    "write_file",
    "list_files",
    "glob",
    "save_memory",
    "recall_memory",
    "save_artifact",
    "read_artifact",
    "list_artifacts",
  ],
  baseInstructions: PLAN_BASE_INSTRUCTIONS,
  maxSteps: 25,
  includeProjectContext: true,
  includeMemories: true,
  includeRecentArtifacts: true,
  injectWorkspaceSummary: true,
  maxMemoryFiles: 6,
  maxRecentArtifacts: 6,
  maxContextChars: 24_000,
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

const PLANNER_BASE_INSTRUCTIONS = `You are a planning assistant with access to hosted workspace tools.
Use code mode when it helps you inspect multiple files, summarize findings, and assemble a concrete implementation plan.
Prefer producing structured artifacts and actionable plans over casual discussion.

When asked for an execution brief, write /.tiller/plan.md if the user explicitly wants a Claude Code container execution brief.`;

export const PLANNER_AGENT_SPEC: AgentSpec = {
  name: PLANNER_AGENT_NAME,
  runtime: "direct-tools",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/nvidia/nemotron-3-120b-a12b",
  },
  toolNames: [
    "read_file",
    "write_file",
    "list_files",
    "glob",
    "recall_memory",
  ],
  baseInstructions: PLANNER_BASE_INSTRUCTIONS,
  maxSteps: 10,
  includeProjectContext: true,
  includeMemories: true,
  includeRecentArtifacts: true,
  injectWorkspaceSummary: true,
  maxMemoryFiles: 6,
  maxRecentArtifacts: 3,
  maxContextChars: 18_000,
};

const CARTOGRAPHER_BASE_INSTRUCTIONS = `You are a repository cartographer running in code mode.
Use code mode when it helps you inspect multiple files, compare related modules, follow patterns, and assemble a coherent map of the codebase.
Stay read-only with respect to the workspace. Do not try to edit files or act like a shell agent.

Your job is to produce clear summaries and architecture maps grounded in the repository.

Always give the user a normal chat response after your exploration. Do not treat tool use as a substitute for answering the user.`;

export const CARTOGRAPHER_AGENT_SPEC: AgentSpec = {
  name: CARTOGRAPHER_AGENT_NAME,
  runtime: "codemode",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/nvidia/nemotron-3-120b-a12b",
  },
  toolNames: [
    "read_file",
    "list_files",
    "glob",
    "recall_memory",
  ],
  baseInstructions: CARTOGRAPHER_BASE_INSTRUCTIONS,
  maxSteps: 6,
  includeProjectContext: true,
  includeMemories: true,
  includeRecentArtifacts: true,
  injectWorkspaceSummary: true,
  maxMemoryFiles: 6,
  maxRecentArtifacts: 3,
  maxContextChars: 18_000,
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
    id: "research-chat",
    label: "Research",
    spec: RESEARCH_AGENT_SPEC,
  },
  {
    id: "planner-chat",
    label: "Planner",
    spec: PLANNER_AGENT_SPEC,
  },
  {
    id: "cartographer-chat",
    label: "Cartographer",
    spec: CARTOGRAPHER_AGENT_SPEC,
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
  if (!name || name === RESEARCH_AGENT_NAME) {
    return RESEARCH_AGENT_SPEC;
  }

  if (name === PLAN_AGENT_NAME) {
    return PLAN_AGENT_SPEC;
  }

  if (name === PLANNER_AGENT_NAME) {
    return PLANNER_AGENT_SPEC;
  }

  if (name === REVIEWER_AGENT_NAME) {
    return REVIEWER_AGENT_SPEC;
  }

  if (name === CARTOGRAPHER_AGENT_NAME) {
    return CARTOGRAPHER_AGENT_SPEC;
  }

  throw new Error(`Unknown agent: ${name}`);
}
