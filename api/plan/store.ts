import { getWorkspaceStub, repoToTarballUrl } from "../helpers";
import {
  hasExplicitEnvDefinitionScmFields,
  hasExplicitEnvScmFields,
  hasExplicitRepoScmFields,
  isEnvHarness,
  isEnvStatus,
  type Env,
  type EnvDefinition,
  type EnvMeta,
  type RepoMeta,
} from "../types";
import type { WorkspaceDO } from "../workspace/do";
import { getSecret } from "../setup/config";
import { createInitialRepoScmState } from "../scm/model";

const PLAN_STORE_PREFIX = "plan-store:";
const REPO_INDEX_PREFIX = "repo:";
const ENV_DEFINITION_PREFIX = "envdef:";
const REPO_META_PATH = "/.tiller/repo/meta.json";

interface RepoIndexEntry {
  repoId: string;
  repoUrl: string;
  updatedAt: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isEnvMetaRecord(value: unknown): value is EnvMeta {
  return (
    isObjectRecord(value) &&
    typeof value.slug === "string" &&
    typeof value.repoUrl === "string" &&
    (value.backend === "cf" || value.backend === "host") &&
    isEnvHarness(typeof value.harness === "string" ? value.harness : null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isEnvStatus(typeof value.status === "string" ? value.status : null) &&
    hasExplicitEnvScmFields(value)
  );
}

function isEnvDefinitionRecord(value: unknown): value is EnvDefinition {
  return (
    isObjectRecord(value) &&
    typeof value.slug === "string" &&
    typeof value.repoUrl === "string" &&
    (value.backend === "cf" || value.backend === "host") &&
    isEnvHarness(typeof value.harness === "string" ? value.harness : null) &&
    typeof value.createdAt === "string" &&
    hasExplicitEnvDefinitionScmFields(value)
  );
}

function isRepoMetaRecord(value: unknown): value is RepoMeta {
  return (
    isObjectRecord(value) &&
    typeof value.repoId === "string" &&
    typeof value.repoUrl === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.bootstrappedFromRef) &&
    hasExplicitRepoScmFields(value)
  );
}

export function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveRepoId(repoUrl: string): Promise<string> {
  return sha256Hex(normalizeRepoUrl(repoUrl));
}

export function getRepoPlanStoreKey(repoUrl: string): string {
  return `${PLAN_STORE_PREFIX}${normalizeRepoUrl(repoUrl)}`;
}

function getRepoIndexKey(repoId: string): string {
  return `${REPO_INDEX_PREFIX}${repoId}`;
}

export function getEnvDefinitionKey(slug: string): string {
  return `${ENV_DEFINITION_PREFIX}${slug}`;
}

export function getRepoWorkspaceStubFromRepoUrl(
  env: Env,
  repoUrl: string,
): WorkspaceDO {
  return getWorkspaceStub(env, getRepoPlanStoreKey(repoUrl));
}

export const getRepoPlanWorkspaceStubFromRepoUrl = getRepoWorkspaceStubFromRepoUrl;

async function writeJsonFile(workspace: WorkspaceDO, path: string, value: unknown): Promise<void> {
  await workspace.writeWorkspaceFile(path, JSON.stringify(value, null, 2));
}

async function hasRepoSnapshot(workspace: WorkspaceDO): Promise<boolean> {
  const rootEntries = await workspace.readWorkspaceDir("/");
  return rootEntries.some((entry) => entry.path !== "/.tiller");
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

  return meta;
}

export async function writeRepoMetaToWorkspace(workspace: WorkspaceDO, meta: RepoMeta): Promise<void> {
  await writeJsonFile(workspace, REPO_META_PATH, meta);
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

export async function readEnvMeta(
  env: Pick<Env, "ENVS_KV">,
  slug: string,
): Promise<EnvMeta | null> {
  return readEnvSummary(env, slug);
}

export async function readEnvSummary(
  env: Pick<Env, "ENVS_KV">,
  slug: string,
): Promise<EnvMeta | null> {
  if (slug.startsWith(REPO_INDEX_PREFIX) || slug.startsWith(ENV_DEFINITION_PREFIX)) {
    return null;
  }

  const raw = await env.ENVS_KV.get(slug);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Env summary for ${slug} is not valid JSON.`);
  }

  if (!isEnvMetaRecord(parsed)) {
    throw new Error(`Env summary for ${slug} is missing explicit environment schema fields.`);
  }

  return parsed;
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

  return parsed;
}

export async function persistEnvDefinition(
  env: Pick<Env, "ENVS_KV">,
  definition: EnvDefinition,
): Promise<EnvDefinition> {
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

export async function listEnvMetas(
  env: Pick<Env, "ENVS_KV">,
): Promise<EnvMeta[]> {
  // Drive from envdef: slugs so unrelated keys in the shared ENVS_KV namespace
  // (e.g. openai:oauth:tokens, tiller:update-check) never masquerade as env summaries.
  const slugs = await listEnvDefinitionSlugs(env);
  const entries = await Promise.all(
    slugs.map(async (slug) => {
      try {
        return await readEnvSummary(env, slug);
      } catch (error) {
        console.warn(
          `[repo-store] Skipping invalid env summary cache row ${slug}:`,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
    }),
  );
  return entries.filter((entry): entry is EnvMeta => !!entry);
}

function buildInitialRepoMeta(args: {
  repoId: string;
  repoUrl: string;
  createdAt: string;
  bootstrappedFromRef: string | null;
}): RepoMeta {
  return {
    repoId: args.repoId,
    repoUrl: args.repoUrl,
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
    repoUrl: meta.repoUrl,
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

export async function ensureRepoWorkspaceFromRepoUrl(
  env: Env,
  repoUrl: string,
): Promise<{ workspace: WorkspaceDO; meta: RepoMeta }> {
  const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
  const workspace = getRepoWorkspaceStubFromRepoUrl(env, normalizedRepoUrl);
  const existingMeta = await readRepoMetaFromWorkspace(workspace);
  if (existingMeta) {
    await ensureRepoIndex(env, existingMeta);
    return { workspace, meta: existingMeta };
  }

  if (await hasRepoSnapshot(workspace)) {
    throw new Error(`Repo workspace for ${normalizedRepoUrl} is missing explicit repo metadata.`);
  }

  const now = new Date().toISOString();
  const repoId = await deriveRepoId(normalizedRepoUrl);

  const githubToken = await getSecret(env, "GITHUB_TOKEN");
  const tarball = repoToTarballUrl(normalizedRepoUrl, "HEAD", githubToken);
  if (!tarball) {
    throw new Error(`Unsupported repo URL: ${normalizedRepoUrl}`);
  }
  await workspace.initFromTarball(tarball.tarballUrl, tarball.headers);

  const meta = buildInitialRepoMeta({
    repoId,
    repoUrl: normalizedRepoUrl,
    createdAt: now,
    bootstrappedFromRef: "HEAD",
  });
  await persistRepoMeta(env, workspace, meta);

  return { workspace, meta };
}

export async function ensureRepoPlanWorkspaceFromRepoUrl(env: Env, repoUrl: string): Promise<WorkspaceDO> {
  const repo = await ensureRepoWorkspaceFromRepoUrl(env, repoUrl);
  return repo.workspace;
}

export async function getRepoWorkspaceForRepoId(
  env: Env,
  repoId: string,
): Promise<{ workspace: WorkspaceDO; meta: RepoMeta } | null> {
  const indexEntry = await readRepoIndexEntry(env, repoId);
  if (!indexEntry) return null;
  return ensureRepoWorkspaceFromRepoUrl(env, indexEntry.repoUrl);
}

export async function getRepoWorkspaceForEnvSlug(
  env: Env,
  slug: string,
): Promise<{ envMeta: EnvMeta; workspace: WorkspaceDO; meta: RepoMeta } | null> {
  const envMeta = await readEnvMeta(env, slug);
  if (!envMeta) return null;
  const repo = await ensureRepoWorkspaceFromRepoUrl(env, envMeta.repoUrl);
  return { envMeta, ...repo };
}

export async function getRepoPlanWorkspaceStub(
  env: Env,
  slug: string,
): Promise<{ meta: EnvMeta; planWorkspace: WorkspaceDO } | null> {
  const repo = await getRepoWorkspaceForEnvSlug(env, slug);
  if (!repo) return null;
  return {
    meta: repo.envMeta,
    planWorkspace: repo.workspace,
  };
}

export async function listRepos(env: Env): Promise<RepoMeta[]> {
  const entries = await listRepoIndexEntries(env);
  const repos = (
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const repo = await ensureRepoWorkspaceFromRepoUrl(env, entry.repoUrl);
          return repo.meta;
        } catch (error) {
          console.warn(`[repo-store] Failed to load repo ${entry.repoUrl}:`, error);
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
