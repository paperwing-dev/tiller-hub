import type { EnvBranchStatus, EnvMeta, RepoMeta } from "../types";
import { buildEnvBranchName } from "./artifacts";
import { SCM_FORMAT_VERSION } from "./constants";

const TRUE_CONFIG_VALUES = new Set(["1", "true", "yes", "on"]);

export function parseScmBooleanFlag(value?: string | null): boolean {
  if (!value) return false;
  return TRUE_CONFIG_VALUES.has(value.trim().toLowerCase());
}

export function createInitialRepoScmState(): Pick<
  RepoMeta,
  | "mainCommit"
  | "gitArtifactId"
  | "gitStatus"
  | "gitError"
  | "gitFormatVersion"
  | "gitProgressPhase"
  | "gitProgressStartedAt"
  | "gitProgressUpdatedAt"
  | "gitLastBootstrapDurationMs"
  | "gitLastBootstrapTimings"
> {
  return {
    mainCommit: null,
    gitArtifactId: null,
    gitStatus: "pending",
    gitError: null,
    gitFormatVersion: SCM_FORMAT_VERSION,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
  };
}

export function createInitialEnvScmState(args: {
  slug: string;
  startupPlanId?: string | null;
  branchName?: string | null;
  mainCommit?: string | null;
}): Pick<
  EnvMeta,
  | "startupPlanId"
  | "branchName"
  | "branchStatus"
  | "workspaceDirty"
  | "workspaceNeedsAttention"
  | "workspaceLastSyncedAt"
  | "baseMainCommit"
  | "lastKnownMainCommit"
  | "scmOperationType"
  | "scmOperationId"
  | "scmOperationPhase"
  | "scmOperationStartedAt"
  | "scmOperationUpdatedAt"
  | "scmLastCompletedAt"
  | "scmLastDurationMs"
  | "scmLastTimings"
> {
  return {
    startupPlanId: args.startupPlanId ?? null,
    branchName: args.branchName ?? buildEnvBranchName(args.slug),
    branchStatus: "up-to-date",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: null,
    baseMainCommit: args.mainCommit ?? null,
    lastKnownMainCommit: args.mainCommit ?? null,
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
  };
}

export function buildScmContainerEnvVars(
  meta?: Pick<EnvMeta, "branchName"> | null,
): Record<string, string> {
  return {
    ...(meta?.branchName ? { TILLER_BRANCH_NAME: meta.branchName } : {}),
  };
}

export function deriveBranchBackedEnvStatus(
  meta: Pick<
    EnvMeta,
    | "branchStatus"
    | "workspaceDirty"
    | "workspaceNeedsAttention"
    | "baseMainCommit"
    | "lastKnownMainCommit"
  >,
  repo: Pick<RepoMeta, "mainCommit">,
): EnvBranchStatus {
  if (meta.branchStatus === "needs-attention" || meta.workspaceNeedsAttention) {
    return "needs-attention";
  }

  const baseMainCommit = meta.baseMainCommit ?? meta.lastKnownMainCommit ?? null;
  if (baseMainCommit && repo.mainCommit && baseMainCommit !== repo.mainCommit) {
    return "behind-main";
  }

  if (meta.workspaceDirty) {
    return "ready-to-merge";
  }

  if (!baseMainCommit && !repo.mainCommit && meta.branchStatus === "ready-to-merge") {
    return meta.branchStatus;
  }

  return "up-to-date";
}

export function withDerivedBranchBackedEnvStatus(
  meta: EnvMeta,
  repo: Pick<RepoMeta, "mainCommit">,
): EnvMeta {
  return {
    ...meta,
    branchStatus: deriveBranchBackedEnvStatus(meta, repo),
  };
}

export function getEffectiveEnvBranchStatus(
  meta: Pick<
    EnvMeta,
    | "branchStatus"
    | "workspaceDirty"
    | "workspaceNeedsAttention"
    | "baseMainCommit"
    | "lastKnownMainCommit"
  >,
  repo: Pick<RepoMeta, "mainCommit"> | null | undefined,
): EnvBranchStatus {
  return deriveBranchBackedEnvStatus(meta, {
    mainCommit: repo?.mainCommit ?? null,
  });
}

export function isEnvTransitioning(
  meta: Pick<EnvMeta, "status" | "scmOperationType">,
): boolean {
  return (
    meta.status === "creating" ||
    meta.status === "starting" ||
    meta.status === "saving" ||
    meta.status === "stopping" ||
    meta.status === "deleting" ||
    !!meta.scmOperationType
  );
}

export function isRepoTransitioning(
  meta: Pick<RepoMeta, "gitStatus">,
): boolean {
  return meta.gitStatus === "pending";
}

export function resolveRequestedStartupPlanId(
  meta: Pick<EnvMeta, "startupPlanId">,
  requestedPlanId?: string | null,
): string | null {
  const requested = requestedPlanId ?? null;
  const stored = meta.startupPlanId ?? null;

  if (requested !== null && requested !== stored) {
    throw new Error(
      "Branch-backed environments freeze the startup plan at creation time. Create a new environment to use a different plan.",
    );
  }

  return stored;
}
