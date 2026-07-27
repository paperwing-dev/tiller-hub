import type { Env } from "../types";
import type { AgentSpec } from "./types";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export function resolveAgentModel(
  env: Pick<Env, "OPENAI_MODEL">,
  spec: AgentSpec,
  overrideModel?: string,
): string {
  if (overrideModel) {
    return overrideModel;
  }

  if (spec.modelTarget.envModelKey === "OPENAI_MODEL") {
    return env.OPENAI_MODEL ?? spec.modelTarget.defaultModel ?? DEFAULT_OPENAI_MODEL;
  }

  return spec.modelTarget.defaultModel ?? DEFAULT_OPENAI_MODEL;
}
