// Shared helpers used across env/routes.ts and workspace/routes.ts

import type { Env } from "./types";
import type { ArtifactStoreDO } from "./coordination";
import type { EnvLifecycleDO } from "./env-lifecycle-do";
import type { ScmBootstrapDO } from "./scm-bootstrap-do";
import type { ScmOperationDO } from "./scm-operation-do";
import type { SandboxDO } from "./sandbox-do";
import type { RepoMergeLockDO } from "./scm/repo-merge-lock-do";
import type { WorkspaceDO } from "./workspace/do";

// Applies the operator-chosen region (set at deploy time from TILLER_REGION) to
// DO placement. Only takes effect on first-create; existing DOs stay put.
export function getLocationHintOptions(
  env: Env,
): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  const hint = env.DO_LOCATION_HINT as DurableObjectLocationHint | undefined;
  return hint ? { locationHint: hint } : undefined;
}

export function getSandboxStub(env: Env, slug: string): SandboxDO {
  const id = env.SANDBOX.idFromName(slug);
  return env.SANDBOX.get(id, getLocationHintOptions(env)) as unknown as SandboxDO;
}

export function getArtifactStoreStub(env: Env, repoId: string): ArtifactStoreDO {
  const id = env.ARTIFACT_STORE.idFromName(repoId);
  return env.ARTIFACT_STORE.get(id, getLocationHintOptions(env)) as unknown as ArtifactStoreDO;
}

export function getEnvLifecycleStub(env: Env, slug: string): EnvLifecycleDO {
  const id = env.ENV_LIFECYCLE.idFromName(slug);
  return env.ENV_LIFECYCLE.get(id, getLocationHintOptions(env)) as unknown as EnvLifecycleDO;
}

export function getScmBootstrapStub(env: Env, slug: string): ScmBootstrapDO {
  const id = env.SCM_BOOTSTRAP.idFromName(slug);
  return env.SCM_BOOTSTRAP.get(id, getLocationHintOptions(env)) as unknown as ScmBootstrapDO;
}

export function getScmOperationStub(env: Env, slug: string): ScmOperationDO {
  const id = env.SCM_OPERATION.idFromName(slug);
  return env.SCM_OPERATION.get(id, getLocationHintOptions(env)) as unknown as ScmOperationDO;
}

export function getWorkspaceStub(env: Env, slug: string): WorkspaceDO {
  const id = env.WORKSPACE.idFromName(slug);
  return env.WORKSPACE.get(id, getLocationHintOptions(env)) as unknown as WorkspaceDO;
}

export function getRepoMergeLockStub(env: Env, repoId: string): RepoMergeLockDO {
  const id = env.REPO_MERGE_LOCK.idFromName(repoId);
  return env.REPO_MERGE_LOCK.get(id, getLocationHintOptions(env)) as unknown as RepoMergeLockDO;
}
