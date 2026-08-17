import { getPlannerRunStub } from "../helpers";
import type { HubDO } from "../hub";
import type { Env, ExecutionPlacement, RunnerCommandClaim, RunnerControlAction } from "../types";
import type {
  PlannerRun,
  PlannerRunLaunchProvenance,
  PlannerRunRuntimeProvenance,
} from "../coordination";
import {
  buildCfAccessEnvVars,
  buildProviderAuthEnvVars,
  destroyPlannerJob,
  plannerDispatchTargetFromLaunch,
  plannerLaunchProvenanceFromExecution,
  resolvePlannerExecution,
  runnerJobCommand,
  type PlannerDispatchTarget,
} from "../planner/dispatch";
import { resolveContainerHubUrl } from "../env/hub-url";
import { redactEnvValues } from "../redaction";
import { bridgeCredentialsToEnvVars, createGitHubBridgeRecord } from "../github/bridge";
import { canonicalizeGitHubRepo } from "../github/repo";
import { mintEnvReviewRunToken } from "./runtime-token";
import type { EnvReviewDO } from "./env-review-do";
import type { EnvReviewRun } from "./types";
import { getDurableObjectStub } from "../durable-object";

interface HubRunnerControl {
  requestLocalRunner(
    machineId: string | null,
    action: Exclude<RunnerControlAction, "status">,
    slug: string,
    options: { repoUrl?: string; envVars?: Record<string, string> } & RunnerCommandClaim,
  ): Promise<{ machineId: string; result: unknown }>;
}

function getHub(env: Env): HubRunnerControl {
  return getDurableObjectStub<HubDO & HubRunnerControl>(env, env.HUB, "hub");
}

export function envReviewJobSlug(runId: string): string {
  const sanitized = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `env-review-${sanitized}`;
}

function providerSelectionForAuth(run: EnvReviewRun): Pick<PlannerRun, "provider" | "model"> {
  return {
    provider: run.provider,
    model: run.model,
  };
}

export interface DispatchEnvReviewRunOptions {
  env: Env;
  requestUrl: string;
  run: EnvReviewRun;
  repoUrl: string;
  githubFullName?: string | null;
  githubBaseCommitSha?: string | null;
  target: EnvReviewDispatchTarget;
}

export type EnvReviewDispatchTarget = PlannerDispatchTarget & { jobSlug: string };

export async function resolveNewEnvReviewLaunchProvenance(
  env: Env,
  provider: string,
): Promise<PlannerRunLaunchProvenance> {
  const execution = await resolvePlannerExecution(env, provider, {
    codexSurface: "environment-reviewer",
  });
  if (execution.kind === "in-process") {
    // Contributor-only fake runs still carry a well-formed placement record
    // so every newly created review row follows the same fail-closed schema.
    return { schemaVersion: 1, backend: "cf", machineId: null };
  }
  if (execution.kind !== "dispatched") {
    throw new Error(execution.kind === "unavailable"
      ? execution.reason
      : "Environment Review requires a dispatched CLI runtime backend for this provider.");
  }
  return plannerLaunchProvenanceFromExecution(execution);
}

export async function resolveEnvReviewDispatchTarget(
  _env: Env,
  run: Pick<EnvReviewRun, "provider" | "runId"> & Partial<Pick<EnvReviewRun, "launchProvenance">>,
): Promise<EnvReviewDispatchTarget> {
  if (!run.launchProvenance) {
    throw new Error(
      `Environment Review run ${run.runId} has no stored execution provenance.`,
    );
  }
  return {
    ...plannerDispatchTargetFromLaunch(run.launchProvenance),
    jobSlug: envReviewJobSlug(run.runId),
  };
}

export async function dispatchEnvReviewRun(options: DispatchEnvReviewRunOptions): Promise<PlannerRunRuntimeProvenance> {
  const { backend, jobSlug } = options.target;
  const runtime: PlannerRunRuntimeProvenance = { jobSlug };
  const hubUrl = await resolveContainerHubUrl(options.env, options.requestUrl, backend);
  const token = await mintEnvReviewRunToken(options.env, options.run.envSlug, options.run.runId);
  const authEnvVars = await buildProviderAuthEnvVars(
    options.env,
    providerSelectionForAuth(options.run),
    options.target,
    hubUrl,
  );
  const githubBaseCommitSha = options.githubBaseCommitSha?.trim() ?? "";
  const githubEnvVars = githubBaseCommitSha
    ? {
        TILLER_GITHUB_BASE_COMMIT_SHA: githubBaseCommitSha,
        ...bridgeCredentialsToEnvVars(await createGitHubBridgeRecord(options.env, {
          subject: {
            type: "github-planner",
            jobSlug,
            repoId: options.run.repoId,
          },
          githubFullName: options.githubFullName?.trim() || canonicalizeGitHubRepo(options.repoUrl).fullName,
        })),
      }
    : {};
  const envVars: Record<string, string> = {
    TILLER_BOOTSTRAP_MODE: "env-review-run",
    TILLER_REVIEWER_ISOLATION_PROTOCOL: "1",
    TILLER_HARNESS: options.run.provider,
    RUNNER_BACKEND: backend,
    HUB_URL: hubUrl,
    REPO_URL: options.repoUrl,
    TILLER_ENV_REVIEW_CALLBACK_BASE:
      `${hubUrl}/api/env-review-runtime/envs/${encodeURIComponent(options.run.envSlug)}/runs/${encodeURIComponent(options.run.runId)}`,
    TILLER_ENV_REVIEW_RUN_TOKEN: token,
    ...githubEnvVars,
    ...authEnvVars,
    ...(await buildCfAccessEnvVars(options.env, options.requestUrl)),
  };

  try {
    if (backend === "cf") {
      await getPlannerRunStub(options.env, jobSlug).startPlannerJob(envVars);
    } else {
      const created = await getHub(options.env).requestLocalRunner(options.target.machineId, "create", jobSlug, {
        repoUrl: options.repoUrl,
        envVars,
        ...runnerJobCommand(jobSlug, "running"),
      });
      if (created.machineId !== options.target.machineId) {
        throw new Error("The execution machine did not match the review’s stored placement.");
      }
    }
  } catch (error) {
    await destroyPlannerJob(options.env, runtime, options.target).catch((cleanupError) => {
      console.error(
        "[env-review] failed to clean up runtime after dispatch error:",
        redactEnvValues(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          envVars,
        ),
      );
    });
    throw new Error(redactEnvValues(
      error instanceof Error ? error.message : String(error),
      envVars,
    ));
  }
  return runtime;
}

export async function cleanupEnvReviewRunRuntime(
  env: Env,
  review: EnvReviewDO,
  run: EnvReviewRun,
): Promise<EnvReviewRun | null> {
  const runtime = run.runtime;
  if (!runtime) return run;
  if (!run.launchProvenance) {
    throw new Error("Environment Review launch provenance is missing.");
  }
  await destroyEnvReviewRuntimeJob(env, runtime, run.launchProvenance);
  return await review.clearRunRuntimeIfCurrent(run.runId, runtime);
}

export async function destroyEnvReviewRuntimeJob(
  env: Env,
  runtime: PlannerRunRuntimeProvenance,
  placement: ExecutionPlacement,
): Promise<void> {
  await destroyPlannerJob(env, runtime, placement);
}
