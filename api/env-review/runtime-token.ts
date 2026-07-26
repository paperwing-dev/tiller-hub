import type { Env } from "../types";
import { mintPlannerRunToken, verifyPlannerRunToken } from "../planner/runtime-token";

function envReviewRuntimeSubject(envSlug: string, runId: string): string {
  return `env-review:${envSlug}:${runId}`;
}

export async function mintEnvReviewRunToken(env: Env, envSlug: string, runId: string): Promise<string> {
  return mintPlannerRunToken(env, envReviewRuntimeSubject(envSlug, runId));
}

export async function verifyEnvReviewRunToken(
  env: Env,
  envSlug: string,
  runId: string,
  token: string | null | undefined,
): Promise<boolean> {
  return verifyPlannerRunToken(env, envReviewRuntimeSubject(envSlug, runId), token);
}
