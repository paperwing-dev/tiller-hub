import type { Env } from "../types";
import type { AgentSpec } from "./types";

export function resolveAgentModel(
  env: Pick<Env, "OPENAI_MODEL">,
  spec: AgentSpec,
  overrideModel?: string,
): string {
  if (overrideModel) {
    return overrideModel;
  }

  if (spec.modelTarget.envModelKey === "OPENAI_MODEL") {
    return env.OPENAI_MODEL ?? spec.modelTarget.defaultModel ?? "gpt-5.4";
  }

  return spec.modelTarget.defaultModel ?? "gpt-5.4";
}
