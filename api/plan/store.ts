import { getWorkspaceStub } from "../helpers";
import {
  hasExplicitEnvDefinitionScmFields,
  hasExplicitRepoScmFields,
  isEnvHarness,
  type Env,
  type EnvDefinition,
  type EnvMeta,
  type RepoMeta,
  type StoredEnvMeta,
} from "../types";
import type { WorkspaceDO } from "../workspace/do";
import { createInitialRepoScmState } from "../scm/model";
import {
  mintGitHubInstallationToken,
  resolveGitHubAppRepositorySelection,
} from "../github/app";
import { buildGitHubTarballRequest, canonicalizeGitHubRepo, githubRepoUrlFromFullName } from "../github/repo";

const PLAN_STORE_PREFIX = "plan-store:";
const REPO_INDEX_PREFIX = "repo:";
const ENV_DEFINITION_PREFIX = "envdef:";
const REPO_META_PATH = "/.tiller/repo/meta.json";

interface RepoIndexEntry {
  repoId: string;
  updatedAt: string;
}

type StoredRepoMeta = Omit<RepoMeta, "repoUrl">;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && value > 0;
}

function isCanonicalGitHubFullName(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return canonicalizeGitHubRepo(value, { allowOwnerRepo: true }).fullName === value;
  } catch {
    return false;
  }
}

function isEnvDefinitionRecord(value: unknown): value is EnvDefinition {
  return (
    isObjectRecord(value) &&
    typeof value.slug === "string" &&
    typeof value.repoId === "string" &&
    (value.backend === "cf" || value.backend === "host") &&
    isEnvHarness(typeof value.harness === "string" ? value.harness : null) &&
    typeof value.createdAt === "string" &&
    hasExplicitEnvDefinitionScmFields(value)
  );
}

function isRepoMetaRecord(value: unknown): value is StoredRepoMeta {
  return (
    isObjectRecord(value) &&
    !("repoUrl" in value) &&
    typeof value.repoId === "string" &&
    isPositiveInteger(value.githubInstallationId) &&
    isCanonicalGitHubFullName(value.githubFullName) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.bootstrappedFromRef) &&
    hasExplicitRepoScmFields(value)
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
    repoUrl: githubRepoUrlFromFullName(meta.githubFullName),
  };
}

export async function writeRepoMetaToWorkspace(workspace: WorkspaceDO, meta: RepoMeta): Promise<void> {
  const { repoUrl: _repoUrl, ...storedMeta } = meta;
  await writeJsonFile(workspace, REPO_META_PATH, storedMeta);
}

export function toStoredEnvMeta(meta: EnvMeta): StoredEnvMeta {
  const { repoUrl: _repoUrl, ...storedMeta } = meta;
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
  const { repoUrl: _repoUrl, ...storedDefinition } = definition as EnvDefinition & { repoUrl?: string };
  await env.ENVS_KV.put(getEnvDefinitionKey(definition.slug), JSON.stringify(storedDefinition));
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
  createdAt: string;
  bootstrappedFromRef: string | null;
}): RepoMeta {
  return {
    repoId: args.repoId,
    repoUrl: githubRepoUrlFromFullName(args.githubFullName),
    githubInstallationId: args.githubInstallationId,
    githubFullName: args.githubFullName,
    ...createInitialRepoScmState(),
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

async function initWorkspaceFromGitHubAppTarball(
  env: Env,
  workspace: WorkspaceDO,
  selection: {
    fullName: string;
    defaultBranch: string | null;
  },
): Promise<void> {
  const token = (await mintGitHubInstallationToken(
    env,
    canonicalizeGitHubRepo(selection.fullName, { allowOwnerRepo: true }),
    { access: "write" },
  )).token;
  const repo = canonicalizeGitHubRepo(selection.fullName, { allowOwnerRepo: true });
  const authedTarball = buildGitHubTarballRequest(repo, selection.defaultBranch ?? "HEAD", token);
  await workspace.initFromTarball(authedTarball.tarballUrl, authedTarball.headers);
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
  if (existingMeta) {
    const nextMeta: RepoMeta = {
      ...existingMeta,
      repoId,
      repoUrl: githubRepoUrlFromFullName(selection.fullName),
      githubInstallationId: selection.installationId,
      githubFullName: selection.fullName,
      updatedAt: new Date().toISOString(),
    };
    await persistRepoMeta(env, workspace, nextMeta);
    return { workspace, meta: nextMeta, created: false };
  }

  const now = new Date().toISOString();
  await initWorkspaceFromGitHubAppTarball(
    env,
    workspace,
    selection,
  );

  const meta = buildInitialRepoMeta({
    repoId,
    githubInstallationId: selection.installationId,
    githubFullName: selection.fullName,
    createdAt: now,
    bootstrappedFromRef: selection.defaultBranch ?? "HEAD",
  });
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

export async function commitRepoMainState(args: {
  env: Env;
  workspace: WorkspaceDO;
  meta: RepoMeta;
  mainCommit: string | null;
  sourceEnvSlug?: string | null;
  metaOverrides?: Partial<RepoMeta>;
}): Promise<RepoMeta> {
  const now = new Date().toISOString();
  const nextMeta: RepoMeta = {
    ...args.meta,
    ...args.metaOverrides,
    mainCommit: args.mainCommit,
    updatedAt: now,
    lastCommittedFromEnvSlug: args.sourceEnvSlug ?? null,
    lastCommittedAt: args.sourceEnvSlug ? now : args.meta.lastCommittedAt ?? null,
  };
  await persistRepoMeta(args.env, args.workspace, nextMeta);
  return nextMeta;
}
