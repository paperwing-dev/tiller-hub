import { getWorkspaceStub } from "../helpers";
import {
  hasExplicitEnvDefinitionScmFields,
  hasExplicitRepoGitHubPublishFields,
  hasExplicitRepoScmFields,
  isExecutionPlacement,
  isEnvHarness,
  type Env,
  type EnvDefinition,
  type EnvMeta,
  type RepoMeta,
  type StoredEnvMeta,
} from "../types";
import type { RepoDefaultHeadIdentity, RepoDefaultHeadPatchInput, RepoDefaultHeadPatchResult, WorkspaceDO } from "../workspace/do";
import { createInitialRepoScmState } from "../scm/model";
import {
  mintGitHubInstallationToken,
  resolveGitHubAppRepositorySelection,
} from "../github/app";
import { canonicalizeGitHubRepo, githubRepoUrlFromFullName } from "../github/repo";
import { readCommitRef } from "../github/git-api";
import { UnsupportedGitHubRepoMetadataError, validateGitHubManagedTree } from "../github/metadata-validation";
import workspacePolicy from "../env/workspace-policy.json";
import { normalizeEnvDisplayName } from "../../shared/env-display-name";

const PLAN_STORE_PREFIX = "plan-store:";
const REPO_INDEX_PREFIX = "repo:";
const ENV_DEFINITION_PREFIX = "envdef:";
const REPO_META_PATH = "/.tiller/repo/meta.json";

interface RepoIndexEntry {
  repoId: string;
  updatedAt: string;
}

type StoredRepoMeta = Omit<RepoMeta, "repoUrl">;
type ReadableStoredRepoMeta =
  & Omit<StoredRepoMeta, "artifactStoreGeneration">
  & { artifactStoreGeneration?: string | null };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isCanonicalGitHubFullName(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return canonicalizeGitHubRepo(value, { allowOwnerRepo: true }).fullName === value;
  } catch {
    return false;
  }
}

const ENV_DEFINITION_KEYS = new Set<keyof EnvDefinition>([
  "slug",
  "displayName",
  "incarnationId",
  "sidebarSlot",
  "repoId",
  "scmModel",
  "executionPlacement",
  "harness",
  "resolvedAuthMode",
  "codexAuthMode",
  "startupPlanId",
  "branchName",
  "createdAt",
]);

function isEnvDefinitionRecord(value: unknown): value is EnvDefinition {
  return (
    isObjectRecord(value) &&
    Object.keys(value).every((key) => ENV_DEFINITION_KEYS.has(key as keyof EnvDefinition)) &&
    typeof value.slug === "string" &&
    (
      value.displayName === undefined
      || (
        typeof value.displayName === "string"
        && normalizeEnvDisplayName(value.displayName) === value.displayName
      )
    ) &&
    typeof value.incarnationId === "string" &&
    Boolean(value.incarnationId.trim()) &&
    (value.sidebarSlot === undefined || isPositiveInteger(value.sidebarSlot)) &&
    typeof value.repoId === "string" &&
    isExecutionPlacement(value.executionPlacement) &&
    isEnvHarness(typeof value.harness === "string" ? value.harness : null) &&
    (
      value.resolvedAuthMode === undefined
      || value.resolvedAuthMode === "subscription"
      || value.resolvedAuthMode === "api"
    ) &&
    (
      value.codexAuthMode === undefined
      || value.codexAuthMode === "subscription"
      || value.codexAuthMode === "api-key"
    ) &&
    typeof value.createdAt === "string" &&
    hasExplicitEnvDefinitionScmFields(value)
  );
}

function isRepoMetaRecord(value: unknown): value is ReadableStoredRepoMeta {
  return (
    isObjectRecord(value) &&
    !("repoUrl" in value) &&
    typeof value.repoId === "string" &&
    (
      value.artifactStoreGeneration === undefined
      || value.artifactStoreGeneration === null
      || (
        typeof value.artifactStoreGeneration === "string"
        && Boolean(value.artifactStoreGeneration.trim())
      )
    ) &&
    isPositiveInteger(value.githubInstallationId) &&
    isCanonicalGitHubFullName(value.githubFullName) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.bootstrappedFromRef) &&
    hasExplicitRepoScmFields(value) &&
    hasExplicitRepoGitHubPublishFields(value)
  );
}

export function getRepoPlanStoreKey(repoId: string): string {
  return `${PLAN_STORE_PREFIX}${repoId.trim()}`;
}

function getRepoIndexKey(repoId: string): string {
  return `${REPO_INDEX_PREFIX}${repoId}`;
}

export function getEnvDefinitionKey(slug: string): string {
  return `${ENV_DEFINITION_PREFIX}${slug}`;
}

export function getRepoWorkspaceStubForRepoId(
  env: Env,
  repoId: string,
): WorkspaceDO {
  return getWorkspaceStub(env, getRepoPlanStoreKey(repoId));
}

async function writeJsonFile(workspace: WorkspaceDO, path: string, value: unknown): Promise<void> {
  await workspace.writeWorkspaceFile(path, JSON.stringify(value, null, 2));
}

export async function readRepoMetaFromWorkspace(workspace: WorkspaceDO): Promise<RepoMeta | null> {
  const raw = await workspace.readWorkspaceFile(REPO_META_PATH);
  if (!raw) return null;

  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new Error(`Repo metadata at ${REPO_META_PATH} is not valid JSON.`);
  }

  if (!isRepoMetaRecord(meta)) {
    throw new Error(`Repo metadata at ${REPO_META_PATH} is missing explicit repository schema fields.`);
  }

  return {
    ...meta,
    artifactStoreGeneration: meta.artifactStoreGeneration?.trim() || null,
    scmModel: "github",
    repoUrl: githubRepoUrlFromFullName(meta.githubFullName),
    githubDefaultBranch: meta.githubDefaultBranch ?? null,
    githubDefaultBranchHeadSha: meta.githubDefaultBranchHeadSha ?? null,
    githubWebhookConfigured: meta.githubWebhookConfigured === true,
    githubWebhookError: meta.githubWebhookError ?? null,
  };
}

export async function writeRepoMetaToWorkspace(workspace: WorkspaceDO, meta: RepoMeta): Promise<void> {
  const { repoUrl: _repoUrl, ...storedMeta } = meta;
  await writeJsonFile(workspace, REPO_META_PATH, storedMeta);
}

export function toStoredEnvMeta(meta: EnvMeta): StoredEnvMeta {
  const {
    repoUrl: _repoUrl,
    harnessPresentation: _harnessPresentation,
    ...storedMeta
  } = meta;
  return storedMeta;
}

export async function persistEnvSummary(
  env: Pick<Env, "ENVS_KV">,
  meta: EnvMeta,
): Promise<void> {
  await env.ENVS_KV.put(meta.slug, JSON.stringify(toStoredEnvMeta(meta)));
}

async function writeRepoIndex(env: Pick<Env, "ENVS_KV">, entry: RepoIndexEntry): Promise<void> {
  await env.ENVS_KV.put(getRepoIndexKey(entry.repoId), JSON.stringify(entry));
}

export async function deleteRepoIndex(env: Pick<Env, "ENVS_KV">, repoId: string): Promise<void> {
  await env.ENVS_KV.delete(getRepoIndexKey(repoId));
}

export async function readRepoIndexEntry(
  env: Pick<Env, "ENVS_KV">,
  repoId: string,
): Promise<RepoIndexEntry | null> {
  const raw = await env.ENVS_KV.get(getRepoIndexKey(repoId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as RepoIndexEntry;
  } catch {
    return null;
  }
}

async function listRepoIndexEntries(env: Pick<Env, "ENVS_KV">): Promise<RepoIndexEntry[]> {
  const listed = await env.ENVS_KV.list({ prefix: REPO_INDEX_PREFIX });
  const entries = await Promise.all(listed.keys.map((key) => env.ENVS_KV.get(key.name)));
  return entries.flatMap((raw) => {
    if (!raw) return [];
    try {
      return [JSON.parse(raw) as RepoIndexEntry];
    } catch {
      return [];
    }
  });
}

export async function listRepoIndexRepoIdsStrict(
  env: Pick<Env, "ENVS_KV">,
): Promise<string[]> {
  const repoIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const listed = await env.ENVS_KV.list({ prefix: REPO_INDEX_PREFIX, cursor });
    for (const key of listed.keys) {
      const raw = await env.ENVS_KV.get(key.name);
      if (!raw) throw new Error(`Repository index ${key.name} disappeared during enumeration.`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error(`Repository index ${key.name} is not valid JSON.`);
      }
      const expectedRepoId = key.name.slice(REPO_INDEX_PREFIX.length).trim();
      if (
        !isObjectRecord(parsed)
        || typeof parsed.repoId !== "string"
        || !parsed.repoId.trim()
        || parsed.repoId !== expectedRepoId
        || typeof parsed.updatedAt !== "string"
      ) {
        throw new Error(`Repository index ${key.name} is malformed.`);
      }
      repoIds.add(parsed.repoId);
    }
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);
  return [...repoIds].sort();
}

export async function readEnvDefinition(
  env: Pick<Env, "ENVS_KV">,
  slug: string,
): Promise<EnvDefinition | null> {
  const raw = await env.ENVS_KV.get(getEnvDefinitionKey(slug));
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Env definition for ${slug} is not valid JSON.`);
  }

  if (!isEnvDefinitionRecord(parsed)) {
    throw new Error(`Env definition for ${slug} is missing explicit environment schema fields.`);
  }
  if (parsed.slug !== slug) {
    throw new Error(`Env definition for ${slug} has mismatched slug ${parsed.slug}.`);
  }

  return parsed;
}

export async function persistEnvDefinition(
  env: Pick<Env, "ENVS_KV">,
  definition: EnvDefinition,
): Promise<EnvDefinition> {
  const slug = definition.slug;
  if (!isEnvDefinitionRecord(definition)) {
    throw new Error(
      `Env definition for ${slug} is missing immutable workload identity or execution placement.`,
    );
  }
  await env.ENVS_KV.put(getEnvDefinitionKey(definition.slug), JSON.stringify(definition));
  return definition;
}

export async function listEnvDefinitionSlugs(
  env: Pick<Env, "ENVS_KV">,
): Promise<string[]> {
  const slugs = new Set<string>();
  let cursor: string | undefined;

  do {
    const listed = await env.ENVS_KV.list({ prefix: ENV_DEFINITION_PREFIX, cursor });
    for (const key of listed.keys) {
      const slug = key.name.slice(ENV_DEFINITION_PREFIX.length).trim();
      if (slug) {
        slugs.add(slug);
      }
    }
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);

  return Array.from(slugs);
}

function buildInitialRepoMeta(args: {
  repoId: string;
  githubInstallationId: number;
  githubFullName: string;
  githubDefaultBranch: string | null;
  githubDefaultBranchHeadSha: string | null;
  createdAt: string;
  bootstrappedFromRef: string | null;
}): RepoMeta {
  const githubDefaultBranchHeadSha = args.githubDefaultBranchHeadSha ?? null;
  return {
    repoId: args.repoId,
    artifactStoreGeneration: crypto.randomUUID(),
    repoUrl: githubRepoUrlFromFullName(args.githubFullName),
    ...createInitialRepoScmState(),
    scmModel: "github",
    githubInstallationId: args.githubInstallationId,
    githubFullName: args.githubFullName,
    githubDefaultBranch: args.githubDefaultBranch,
    githubDefaultBranchHeadSha,
    githubWebhookConfigured: false,
    githubWebhookError: null,
    mainCommit: null,
    gitArtifactId: null,
    gitStatus: githubDefaultBranchHeadSha ? "ready" : "repair-required",
    gitError: githubDefaultBranchHeadSha ? null : "GitHub default branch head is unavailable.",
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
    bootstrappedFromRef: args.bootstrappedFromRef,
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
  };
}

async function ensureRepoIndex(env: Pick<Env, "ENVS_KV">, meta: RepoMeta): Promise<void> {
  await writeRepoIndex(env, {
    repoId: meta.repoId,
    updatedAt: meta.updatedAt,
  });
}

export async function persistRepoMeta(
  env: Pick<Env, "ENVS_KV">,
  workspace: WorkspaceDO,
  meta: RepoMeta,
): Promise<void> {
  await writeRepoMetaToWorkspace(workspace, meta);
  await ensureRepoIndex(env, meta);
}

export function repoDefaultHeadIdentityFromMeta(meta: RepoMeta): RepoDefaultHeadIdentity {
  return {
    githubFullName: meta.githubFullName,
    repoUrl: meta.repoUrl,
    githubDefaultBranch: meta.githubDefaultBranch ?? null,
    githubDefaultBranchHeadSha: meta.githubDefaultBranchHeadSha ?? null,
    gitStatus: meta.gitStatus,
    gitError: meta.gitError,
  };
}

function repoDefaultHeadIdentityEquals(left: RepoDefaultHeadIdentity, right: RepoDefaultHeadIdentity): boolean {
  return (
    left.githubFullName === right.githubFullName &&
    left.repoUrl === right.repoUrl &&
    left.githubDefaultBranch === right.githubDefaultBranch &&
    left.githubDefaultBranchHeadSha === right.githubDefaultBranchHeadSha &&
    left.gitStatus === right.gitStatus &&
    left.gitError === right.gitError
  );
}

export async function patchRepoDefaultHeadIfCurrent(args: {
  env: Pick<Env, "ENVS_KV">;
  workspace: WorkspaceDO;
  expected: RepoDefaultHeadPatchInput["expected"];
  next: RepoDefaultHeadPatchInput["next"];
}): Promise<RepoDefaultHeadPatchResult> {
  if (typeof args.workspace.patchRepoDefaultHeadIfCurrent === "function") {
    const result = await args.workspace.patchRepoDefaultHeadIfCurrent({
      expected: args.expected,
      next: args.next,
    });
    if (result.repo) {
      await ensureRepoIndex(args.env, result.repo);
    }
    return result;
  }

  const current = await readRepoMetaFromWorkspace(args.workspace);
  if (!current) {
    return { repo: null, changed: false, mainChanged: false, conflict: true };
  }
  const currentIdentity = repoDefaultHeadIdentityFromMeta(current);
  if (!repoDefaultHeadIdentityEquals(currentIdentity, args.expected)) {
    return { repo: current, changed: false, mainChanged: false, conflict: true };
  }

  const nextWebhookConfigured = args.next.githubWebhookConfigured ?? current.githubWebhookConfigured;
  const nextWebhookError = Object.prototype.hasOwnProperty.call(args.next, "githubWebhookError")
    ? args.next.githubWebhookError ?? null
    : current.githubWebhookError;
  const nextInstallationId = typeof args.next.githubInstallationId === "number"
    ? args.next.githubInstallationId
    : current.githubInstallationId;
  const semanticChanged =
    !repoDefaultHeadIdentityEquals(currentIdentity, args.next) ||
    current.githubInstallationId !== nextInstallationId ||
    current.githubWebhookConfigured !== nextWebhookConfigured ||
    current.githubWebhookError !== nextWebhookError;
  if (!semanticChanged) {
    return { repo: current, changed: false, mainChanged: false, conflict: false };
  }

  const nextMeta: RepoMeta = {
    ...current,
    scmModel: "github",
    githubInstallationId: nextInstallationId,
    repoUrl: args.next.repoUrl,
    githubFullName: args.next.githubFullName,
    githubDefaultBranch: args.next.githubDefaultBranch,
    githubDefaultBranchHeadSha: args.next.githubDefaultBranchHeadSha,
    githubWebhookConfigured: nextWebhookConfigured,
    githubWebhookError: nextWebhookError,
    mainCommit: null,
    gitArtifactId: null,
    gitStatus: args.next.gitStatus,
    gitError: args.next.gitError,
    updatedAt: new Date().toISOString(),
  };
  await persistRepoMeta(args.env, args.workspace, nextMeta);
  return {
    repo: nextMeta,
    changed: true,
    mainChanged: current.githubDefaultBranchHeadSha !== nextMeta.githubDefaultBranchHeadSha,
    conflict: false,
  };
}

export async function patchRepoGitHubPublishMetaIfCurrent(args: {
  env: Pick<Env, "ENVS_KV">;
  workspace: WorkspaceDO;
  expectedMainCommit: string;
  operationId: string;
  githubPublish: NonNullable<RepoMeta["githubPublish"]>;
  final?: boolean;
}): Promise<RepoMeta | null> {
  if (typeof args.workspace.patchRepoGitHubPublishMetaIfCurrent === "function") {
    const patched = await args.workspace.patchRepoGitHubPublishMetaIfCurrent({
      expectedMainCommit: args.expectedMainCommit,
      operationId: args.operationId,
      githubPublish: args.githubPublish,
      final: args.final,
    });
    if (!patched) return null;
    const current = await readRepoMetaFromWorkspace(args.workspace);
    if (current) {
      await ensureRepoIndex(args.env, current);
    }
    return current;
  }

  const current = await readRepoMetaFromWorkspace(args.workspace);
  if (!current || current.mainCommit !== args.expectedMainCommit) {
    return null;
  }
  const recordedOperationId = current.githubPublish?.operationId ?? null;
  if (args.final && recordedOperationId && recordedOperationId !== args.operationId) {
    return null;
  }
  const nextMeta: RepoMeta = {
    ...current,
    githubPublish: args.githubPublish,
    updatedAt: args.githubPublish.updatedAt,
  };
  await persistRepoMeta(args.env, args.workspace, nextMeta);
  return nextMeta;
}

export async function readGitHubDefaultBranchState(
  env: Env,
  selection: {
    fullName: string;
    defaultBranch: string | null;
  },
): Promise<{ headSha: string | null; error: string | null }> {
  const defaultBranch = selection.defaultBranch?.trim() ?? "";
  if (!defaultBranch) return { headSha: null, error: "GitHub default branch is unavailable." };
  const token = (await mintGitHubInstallationToken(
    env,
    canonicalizeGitHubRepo(selection.fullName, { allowOwnerRepo: true }),
    { access: "write" },
  )).token;
  const repo = canonicalizeGitHubRepo(selection.fullName, { allowOwnerRepo: true });
  const client = { token, repo };
  const headSha = await readCommitRef(client, "heads", defaultBranch);
  if (!headSha) return { headSha: null, error: "GitHub default branch head is unavailable." };
  try {
    await validateGitHubManagedTree({
      client,
      commitSha: headSha,
      excludePrefixes: workspacePolicy.envOnlyCanonicalExcludes,
    });
  } catch (error) {
    if (error instanceof UnsupportedGitHubRepoMetadataError) {
      return { headSha, error: error.message };
    }
    throw error;
  }
  return { headSha, error: null };
}

export async function createRepoWorkspaceFromGitHubAppSelection(
  env: Env,
  claim: {
    repositoryId: number;
    installationId: number;
    fullName: string;
  },
): Promise<{ workspace: WorkspaceDO; meta: RepoMeta; created: boolean }> {
  const selection = await resolveGitHubAppRepositorySelection(env, claim);
  const repoId = String(selection.repositoryId);
  const workspace = getRepoWorkspaceStubForRepoId(env, repoId);
  const existingMeta = await readRepoMetaFromWorkspace(workspace);
  const githubDefaultBranchState = await readGitHubDefaultBranchState(env, selection);
  const githubDefaultBranchHeadSha = githubDefaultBranchState.headSha;
  const githubReadinessError = githubDefaultBranchState.error;
  if (existingMeta) {
    const patched = await patchRepoDefaultHeadIfCurrent({
      env,
      workspace,
      expected: repoDefaultHeadIdentityFromMeta(existingMeta),
      next: {
        githubInstallationId: selection.installationId,
        githubFullName: selection.fullName,
        repoUrl: githubRepoUrlFromFullName(selection.fullName),
        githubDefaultBranch: selection.defaultBranch,
        githubDefaultBranchHeadSha: githubDefaultBranchHeadSha,
        gitStatus: githubDefaultBranchHeadSha && !githubReadinessError ? "ready" : "repair-required",
        gitError: githubReadinessError,
      },
    });
    if (patched.repo && !patched.conflict) {
      return { workspace, meta: patched.repo, created: false };
    }

    const reloadedMeta = await readRepoMetaFromWorkspace(workspace);
    if (!reloadedMeta) {
      throw new Error("Repository metadata changed during GitHub App selection refresh.");
    }
    const latestDefaultBranchState = await readGitHubDefaultBranchState(env, selection);
    const latestHeadSha = latestDefaultBranchState.headSha;
    const latestReadinessError = latestDefaultBranchState.error;
    const latestNext = {
      githubInstallationId: selection.installationId,
      githubFullName: selection.fullName,
      repoUrl: githubRepoUrlFromFullName(selection.fullName),
      githubDefaultBranch: selection.defaultBranch,
      githubDefaultBranchHeadSha: latestHeadSha,
      gitStatus: latestHeadSha && !latestReadinessError ? "ready" as const : "repair-required" as const,
      gitError: latestReadinessError,
    };
    const retried = await patchRepoDefaultHeadIfCurrent({
      env,
      workspace,
      expected: repoDefaultHeadIdentityFromMeta(reloadedMeta),
      next: latestNext,
    });
    if (retried.repo && !retried.conflict) {
      return { workspace, meta: retried.repo, created: false };
    }
    const finalMeta = await readRepoMetaFromWorkspace(workspace);
    if (
      finalMeta &&
      repoDefaultHeadIdentityEquals(repoDefaultHeadIdentityFromMeta(finalMeta), latestNext)
    ) {
      return { workspace, meta: finalMeta, created: false };
    }
    throw new Error("Repository metadata changed during GitHub App selection refresh.");
  }

  const now = new Date().toISOString();
  const meta = buildInitialRepoMeta({
    repoId,
    githubInstallationId: selection.installationId,
    githubFullName: selection.fullName,
    githubDefaultBranch: selection.defaultBranch,
    githubDefaultBranchHeadSha,
    createdAt: now,
    bootstrappedFromRef: selection.defaultBranch ?? null,
  });
  if (githubReadinessError) {
    meta.gitStatus = "repair-required";
    meta.gitError = githubReadinessError;
  }
  await persistRepoMeta(env, workspace, meta);

  return { workspace, meta, created: true };
}

export async function getRepoWorkspaceForRepoId(
  env: Env,
  repoId: string,
): Promise<{ workspace: WorkspaceDO; meta: RepoMeta } | null> {
  const indexEntry = await readRepoIndexEntry(env, repoId);
  if (!indexEntry) return null;
  const workspace = getRepoWorkspaceStubForRepoId(env, indexEntry.repoId);
  const meta = await readRepoMetaFromWorkspace(workspace);
  return meta ? { workspace, meta } : null;
}

async function assertRepoStillSelectedInGitHubApp(
  env: Env,
  meta: RepoMeta,
): Promise<void> {
  await resolveGitHubAppRepositorySelection(env, {
    repositoryId: Number(meta.repoId),
    installationId: meta.githubInstallationId,
    fullName: meta.githubFullName,
  });
}

export type SelectedRepoWorkspace = { workspace: WorkspaceDO; meta: RepoMeta };

export async function getSelectedRepoWorkspaceForRepoId(
  env: Env,
  repoId: string,
): Promise<SelectedRepoWorkspace | null> {
  const repo = await getRepoWorkspaceForRepoId(env, repoId);
  if (!repo) return null;
  await assertRepoStillSelectedInGitHubApp(env, repo.meta);
  return repo;
}

export async function listRepos(env: Env): Promise<RepoMeta[]> {
  const entries = await listRepoIndexEntries(env);
  const repos = (
    await Promise.all(
      entries.map(async (entry) => {
        try {
          return (await getRepoWorkspaceForRepoId(env, entry.repoId))?.meta ?? null;
        } catch (error) {
          console.warn(`[repo-store] Failed to load repo ${entry.repoId}:`, error);
          return null;
        }
      }),
    )
  ).filter((repo): repo is RepoMeta => !!repo);

  const deduped = new Map<string, RepoMeta>();
  for (const repo of repos) {
    deduped.set(repo.repoId, repo);
  }
  return Array.from(deduped.values()).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
