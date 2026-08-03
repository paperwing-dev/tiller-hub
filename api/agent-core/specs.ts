import type { ReviewerAgentSpec } from "./types";

const REVIEWER_BASE_INSTRUCTIONS = `You are a code review assistant with read-only access to the workspace.
Inspect the relevant files before answering. Focus on bugs, risks, missing tests, and behavioral regressions.
Do not propose speculative changes unless the user asks for them explicitly.`;

export const REVIEWER_AGENT_SPEC: ReviewerAgentSpec = {
  baseInstructions: REVIEWER_BASE_INSTRUCTIONS,
  maxSteps: 8,
  maxContextChars: 16_000,
};
