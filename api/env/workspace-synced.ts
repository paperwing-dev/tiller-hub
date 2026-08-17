import { getWorkspaceStub } from "../helpers";
import type { Env, EnvMeta } from "../types";
import type { StopWorkspaceSyncedMetaPatch } from "../env-lifecycle";
import type {
  RepoAccessFailure,
  RepoAccessResult,
  RepoWorkspace,
} from "../repo/access";
import {
  deriveBranchBackedEnvStatus,
  deriveGitHubEnvBranchStatus,
} from "../scm/model";
import { TREE_HASH_EXCLUDES } from "./launch-config";

export type WorkspaceSyncedPatchResult =
  | { ok: true; patch: Partial<StopWorkspaceSyncedMetaPatch> }
  | RepoAccessFailure;

export async function buildWorkspaceSyncedPatch(
  env: Env,
  meta: EnvMeta,
  basePatch: Partial<StopWorkspaceSyncedMetaPatch>,
  loadRepo: () => Promise<RepoAccessResult<RepoWorkspace>>,
): Promise<WorkspaceSyncedPatchResult> {
  try {
    const loadedRepo = await loadRepo();
    if (!loadedRepo.ok) {
      if (loadedRepo.body.code === "github_app_public_hub_disabled") {
        return loadedRepo;
      }
      throw new Error(
        typeof loadedRepo.body.error === "string"
          ? loadedRepo.body.error
          : "Repository metadata is not available.",
      );
    }
    const repo = loadedRepo.repo;
    const envWorkspace = getWorkspaceStub(env, meta.slug);
    const workspaceDirty = meta.scmModel === "github"
      ? await (async () => {
          const [draftManifest, deletedPaths] = await Promise.all([
            envWorkspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
            envWorkspace.readGitHubDeletedWorkspacePaths(),
          ]);
          return draftManifest.length > 0 || deletedPaths.length > 0;
        })()
      : await (async () => {
          const [repoTreeHash, envTreeHash] = await Promise.all([
            repo.workspace.computeWorkspaceTreeHash({ excludePrefixes: TREE_HASH_EXCLUDES }),
            envWorkspace.computeWorkspaceTreeHash({ excludePrefixes: TREE_HASH_EXCLUDES }),
          ]);
          return repoTreeHash !== envTreeHash;
        })();
    const currentMainCommit = meta.scmModel === "github"
      ? repo.meta.githubDefaultBranchHeadSha ?? null
      : repo.meta.mainCommit ?? null;
    const baseMainCommit = workspaceDirty
      ? (meta.scmModel === "github" ? null : meta.baseMainCommit ?? meta.lastKnownMainCommit ?? null)
      : currentMainCommit;
    const nextMeta = {
      ...meta,
      workspaceDirty,
      workspaceNeedsAttention: false,
      baseMainCommit,
      lastKnownMainCommit: currentMainCommit,
    };

    return {
      ok: true,
      patch: {
        ...basePatch,
        workspaceDirty,
        workspaceNeedsAttention: false,
        baseMainCommit,
        lastKnownMainCommit: currentMainCommit,
        branchStatus: meta.scmModel === "github"
          ? deriveGitHubEnvBranchStatus(nextMeta, repo.meta)
          : deriveBranchBackedEnvStatus(nextMeta, repo.meta),
      },
    };
  } catch (error) {
    console.warn(
      `[envs] Failed to classify saved workspace for ${meta.slug}:`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: true,
      patch: {
        ...basePatch,
        workspaceNeedsAttention: true,
        branchStatus: "needs-attention",
      },
    };
  }
}
