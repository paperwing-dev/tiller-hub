import type { Env, EnvMeta } from "../types";
import { loadEnvView } from "../env/view";
import { loadTrackedRepo, type RepoWorkspace } from "../repo/access";
import { canonicalizeGitHubRepo } from "./repo";
import type { CanonicalGitHubRepo } from "./repo";

const BRIDGE_PREFIX = "github-bridge:";
const INTERACTIVE_TTL_SECONDS = 7 * 24 * 60 * 60;
const GITHUB_PLANNER_TTL_SECONDS = 12 * 60 * 60;
const GITHUB_ENV_PUBLISH_TTL_SECONDS = 2 * 60 * 60;

export type GitHubBridgeSubject =
  | { type: "interactive-env"; envSlug: string; incarnationId?: string; startOpId?: string }
  | { type: "github-planner"; jobSlug: string; repoId: string }
  | {
      type: "github-env-publish";
      jobSlug: string;
      envSlug: string;
      repoId: string;
      operationId: string;
      tokenAccess?: "write" | "publish";
    };

export interface GitHubBridgeRecord {
  id: string;
  secretHash: string;
  subject: GitHubBridgeSubject;
  allowedRepo: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface GitHubBridgeCredentials {
  id: string;
  secret: string;
  allowedRepo: string;
  expiresAt: string;
}

export type GitHubBridgeTokenAccess = "read" | "write" | "publish";

export interface GitHubBridgeValidationFailure {
  ok: false;
  status: number;
  body: {
    error: string;
    code: string;
  };
}

export type GitHubBridgeValidationResult =
  | { ok: true; record: GitHubBridgeRecord; repo: CanonicalGitHubRepo }
  | GitHubBridgeValidationFailure;

function bridgeRepoMismatchFailure(
  error = "GitHub bridge is not allowed to access the requested repository.",
): GitHubBridgeValidationFailure {
  return {
    ok: false,
    status: 403,
    body: {
      error,
      code: "github_bridge_repo_mismatch",
    },
  };
}

function bridgeKey(id: string): string {
  return `${BRIDGE_PREFIX}${id}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomSecret(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ttlForSubject(subject: GitHubBridgeSubject): number {
  switch (subject.type) {
    case "interactive-env":
      return INTERACTIVE_TTL_SECONDS;
    case "github-planner":
      return GITHUB_PLANNER_TTL_SECONDS;
    case "github-env-publish":
      return GITHUB_ENV_PUBLISH_TTL_SECONDS;
  }
}

function parseRecord(raw: string | null): GitHubBridgeRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GitHubBridgeRecord;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.secretHash === "string" &&
      typeof parsed.allowedRepo === "string" &&
      typeof parsed.expiresAt === "string" &&
      parsed.subject &&
      typeof parsed.subject === "object"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function isInactiveEnvStatus(status: EnvMeta["status"] | undefined): boolean {
  return !status || status === "stopped" || status === "failed" || status === "deleting" || status === "unknown";
}

async function validateSubjectRepoAccess(
  env: Env,
  repoId: string,
  allowedRepo: string,
): Promise<GitHubBridgeValidationFailure | null> {
  const result = await loadSubjectRepo(env, repoId);
  if (!result.ok) return result;

  let storedRepo: CanonicalGitHubRepo;
  try {
    storedRepo = canonicalizeGitHubRepo(result.repo.meta.githubFullName, { allowOwnerRepo: true });
  } catch {
    return bridgeRepoMismatchFailure("GitHub bridge subject no longer matches the stored repository.");
  }
  if (result.repo.meta.repoId !== repoId || storedRepo.fullName !== allowedRepo) {
    return bridgeRepoMismatchFailure("GitHub bridge subject no longer matches the stored repository.");
  }
  return null;
}

async function loadSubjectRepo(
  env: Env,
  repoId: string,
): Promise<{ ok: true; repo: RepoWorkspace } | GitHubBridgeValidationFailure> {
  const loadedRepo = await loadTrackedRepo(env, repoId);
  if (loadedRepo.ok) return loadedRepo;
  return {
    ok: false,
    status: loadedRepo.status === 404 ? 403 : loadedRepo.status,
    body: loadedRepo.body,
  };
}

async function validateSubject(env: Env, record: GitHubBridgeRecord): Promise<GitHubBridgeValidationFailure | null> {
  const subject = record.subject;
  if (subject.type === "interactive-env") {
    const meta = await loadEnvView(env, subject.envSlug).catch(() => null);
    if (!meta || isInactiveEnvStatus(meta.status)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "GitHub bridge subject is no longer active.",
          code: "github_bridge_subject_inactive",
        },
      };
    }
    const repoFailure = await validateSubjectRepoAccess(env, meta.repoId, record.allowedRepo);
    if (repoFailure) return repoFailure;
    return null;
  }

  const repoFailure = await validateSubjectRepoAccess(env, subject.repoId, record.allowedRepo);
  if (repoFailure) return repoFailure;
  if (subject.type === "github-planner") {
    return null;
  }
  if (subject.type === "github-env-publish") {
    const meta = await loadEnvView(env, subject.envSlug).catch(() => null);
    if (
      !meta ||
      meta.repoId !== subject.repoId ||
      meta.githubPublishOperationId !== subject.operationId ||
      meta.githubPublishStatus !== "publishing"
    ) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "GitHub bridge publish subject is no longer the active pending operation.",
          code: "github_bridge_subject_inactive",
        },
      };
    }
    return null;
  }
  return null;
}

export async function createGitHubBridgeRecord(
  env: Env,
  args: {
    subject: GitHubBridgeSubject;
    githubFullName: string;
  },
): Promise<GitHubBridgeCredentials> {
  const repo = canonicalizeGitHubRepo(args.githubFullName, { allowOwnerRepo: true });
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  const ttlSeconds = ttlForSubject(args.subject);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const record: GitHubBridgeRecord = {
    id,
    secretHash: await sha256Hex(secret),
    subject: args.subject,
    allowedRepo: repo.fullName,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  await env.ENVS_KV.put(bridgeKey(id), JSON.stringify(record), {
    expirationTtl: ttlSeconds,
  });
  return {
    id,
    secret,
    allowedRepo: repo.fullName,
    expiresAt,
  };
}

export function bridgeCredentialsToEnvVars(credentials: GitHubBridgeCredentials): Record<string, string> {
  return {
    TILLER_GITHUB_BRIDGE_ID: credentials.id,
    TILLER_GITHUB_BRIDGE_SECRET: credentials.secret,
    TILLER_GITHUB_ALLOWED_REPO: credentials.allowedRepo,
  };
}

export function githubBridgeTokenAccess(record: GitHubBridgeRecord): GitHubBridgeTokenAccess {
  if (record.subject.type !== "github-env-publish") return "read";
  return record.subject.tokenAccess === "publish" ? "publish" : "write";
}

export async function validateGitHubBridgeRequest(
  env: Env,
  request: Request,
  repoValue: string | null | undefined,
): Promise<GitHubBridgeValidationResult> {
  if (!repoValue?.trim()) {
    return {
      ok: false,
      status: 400,
      body: { error: "repo is required", code: "github_repo_required" },
    };
  }

  let repo: CanonicalGitHubRepo;
  try {
    repo = canonicalizeGitHubRepo(repoValue, { allowOwnerRepo: true });
  } catch (error) {
    return {
      ok: false,
      status: 400,
      body: {
        error: error instanceof Error ? error.message : "Invalid GitHub repo.",
        code: "github_repo_invalid",
      },
    };
  }

  const bridgeId = request.headers.get("X-Tiller-GitHub-Bridge-Id")?.trim() ?? "";
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const secret = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!bridgeId || !secret) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "GitHub bridge ID and bearer secret are required.",
        code: "github_bridge_auth_required",
      },
    };
  }

  const record = parseRecord(await env.ENVS_KV.get(bridgeKey(bridgeId)));
  if (!record) {
    return {
      ok: false,
      status: 401,
      body: { error: "GitHub bridge was not found.", code: "github_bridge_not_found" },
    };
  }
  if (record.revokedAt) {
    return {
      ok: false,
      status: 401,
      body: { error: "GitHub bridge has been revoked.", code: "github_bridge_revoked" },
    };
  }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    return {
      ok: false,
      status: 401,
      body: { error: "GitHub bridge has expired.", code: "github_bridge_expired" },
    };
  }
  if (record.secretHash !== await sha256Hex(secret)) {
    return {
      ok: false,
      status: 401,
      body: { error: "Invalid GitHub bridge secret.", code: "github_bridge_secret_invalid" },
    };
  }
  if (record.allowedRepo !== repo.fullName) {
    return bridgeRepoMismatchFailure();
  }

  const subjectFailure = await validateSubject(env, record);
  if (subjectFailure) return subjectFailure;

  return { ok: true, record, repo };
}

async function updateMatchingBridgeRecords(
  env: Env,
  matches: (record: GitHubBridgeRecord) => boolean,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.ENVS_KV.list({ prefix: BRIDGE_PREFIX, cursor });
    await Promise.all(
      listed.keys.map(async (key) => {
        const record = parseRecord(await env.ENVS_KV.get(key.name));
        if (!record || record.revokedAt || !matches(record)) return;
        const expiresAtMs = Date.parse(record.expiresAt);
        const remainingSeconds = Number.isFinite(expiresAtMs)
          ? Math.max(60, Math.ceil((expiresAtMs - Date.now()) / 1000))
          : 60;
        await env.ENVS_KV.put(
          key.name,
          JSON.stringify({
            ...record,
            revokedAt: new Date().toISOString(),
          }),
          { expirationTtl: remainingSeconds },
        );
      }),
    );
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);
}

export async function revokeGitHubBridgesForInteractiveEnv(env: Env, envSlug: string): Promise<void> {
  await updateMatchingBridgeRecords(
    env,
    (record) => record.subject.type === "interactive-env" && record.subject.envSlug === envSlug,
  );
}

export async function revokeGitHubBridgeForEnvironmentStart(
  env: Env,
  input: { bridgeId: string; envSlug: string; incarnationId: string; startOpId: string },
): Promise<boolean> {
  const bridgeId = input.bridgeId.trim();
  if (!bridgeId) return false;
  const key = bridgeKey(bridgeId);
  const record = parseRecord(await env.ENVS_KV.get(key));
  if (!record) return true;
  if (
    record.id !== bridgeId
    || record.subject.type !== "interactive-env"
    || record.subject.envSlug !== input.envSlug
    || record.subject.incarnationId !== input.incarnationId
    || record.subject.startOpId !== input.startOpId
  ) return false;
  if (record.revokedAt) return true;
  const expiresAtMs = Date.parse(record.expiresAt);
  await env.ENVS_KV.put(key, JSON.stringify({
    ...record,
    revokedAt: new Date().toISOString(),
  } satisfies GitHubBridgeRecord), {
    expirationTtl: Number.isFinite(expiresAtMs)
      ? Math.max(60, Math.ceil((expiresAtMs - Date.now()) / 1000))
      : 60,
  });
  return true;
}

export async function revokeGitHubBridgesForEnvironmentStart(
  env: Env,
  input: { envSlug: string; incarnationId: string; startOpId: string },
): Promise<void> {
  await updateMatchingBridgeRecords(
    env,
    (record) => record.subject.type === "interactive-env"
      && record.subject.envSlug === input.envSlug
      && record.subject.incarnationId === input.incarnationId
      && record.subject.startOpId === input.startOpId,
  );
}

export async function revokeGitHubBridgesForEnvPublish(
  env: Env,
  args: { repoId: string; operationId: string },
): Promise<void> {
  await updateMatchingBridgeRecords(
    env,
    (record) =>
      record.subject.type === "github-env-publish" &&
      record.subject.repoId === args.repoId &&
      record.subject.operationId === args.operationId,
  );
}

export async function revokeGitHubBridgesForPlannerJob(
  env: Env,
  args: { repoId: string; jobSlug: string },
): Promise<void> {
  await updateMatchingBridgeRecords(
    env,
    (record) =>
      record.subject.type === "github-planner" &&
      record.subject.repoId === args.repoId &&
      record.subject.jobSlug === args.jobSlug,
  );
}
