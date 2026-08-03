import { getEnvLifecycleStub } from "../helpers";
import type { Env, EnvMeta, RepoMeta } from "../types";
import type { HubDO } from "../hub";
import { buildEnvScmMetaPatch } from "../env-lifecycle";
import { getHub, listEnvViews, projectAndPersistEnvSummary } from "../env/service";
import { patchRepoDefaultHeadIfCurrent, repoDefaultHeadIdentityFromMeta } from "../plan/store";
import { loadTrackedRepo, type RepoWorkspace } from "../repo/access";
import { projectRepoSummary } from "../sync/projectors";
import { getSecret } from "../setup/config";
import { deriveGitHubEnvBranchStatus } from "../scm/model";
import { handleGitHubDraftPrPublishResult } from "./env-publish-service";
import { adoptionPayload, hmacHex } from "./adoption";
import { mintGitHubInstallationToken } from "./app";
import { canonicalizeGitHubRepo, githubRepoUrlFromFullName } from "./repo";
import { getDurableObjectStub } from "../durable-object";

type RouteResult = { status: number; body: Record<string, unknown> };

type HubWebhookConfigStore = Pick<HubDO, "getConfig" | "setConfig" | "compareAndSetConfig">;

const DELIVERY_CONFIG_PREFIX = "GITHUB_WEBHOOK_DELIVERY:";
const ZERO_SHA = "0000000000000000000000000000000000000000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getHubConfigStore(env: Env): HubWebhookConfigStore {
  return getDurableObjectStub<HubWebhookConfigStore>(env, env.HUB, "hub");
}

function nowIso(): string {
  return new Date().toISOString();
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

async function verifySignature(secret: string, rawBody: ArrayBuffer, header: string | null): Promise<boolean> {
  const expectedPrefix = "sha256=";
  if (!header?.startsWith(expectedPrefix)) return false;
  const provided = hexToBytes(header.slice(expectedPrefix.length));
  if (!provided) return false;
  const computed = hexToBytes(await hmacHex(secret, rawBody));
  return computed ? timingSafeEqual(computed, provided) : false;
}

async function claimDelivery(env: Env, deliveryId: string, eventName: string): Promise<boolean> {
  const key = `${DELIVERY_CONFIG_PREFIX}${deliveryId}`;
  const store = getHubConfigStore(env);
  const value = JSON.stringify({ event: eventName, receivedAt: nowIso() });
  if (typeof store.compareAndSetConfig === "function") {
    return await store.compareAndSetConfig(key, "", value);
  }
  if (await store.getConfig(key)) return false;
  await store.setConfig(key, value);
  return true;
}

function readRepository(payload: Record<string, unknown>): { repoId: string; fullName: string; defaultBranch: string | null } | null {
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const id = repository?.id;
  const fullName = repository?.full_name;
  const defaultBranch = repository?.default_branch;
  if (!Number.isInteger(id) || typeof fullName !== "string" || !fullName.trim()) return null;
  let canonicalFullName: string;
  try {
    canonicalFullName = canonicalizeGitHubRepo(fullName.trim(), { allowOwnerRepo: true }).fullName;
  } catch {
    return null;
  }
  return {
    repoId: String(id),
    fullName: canonicalFullName,
    defaultBranch: typeof defaultBranch === "string" && defaultBranch.trim() ? defaultBranch.trim() : null,
  };
}

function readInstallationId(payload: Record<string, unknown>): number | null {
  const installation = isRecord(payload.installation) ? payload.installation : null;
  const id = installation?.id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

async function loadMatchedRepo(env: Env, payload: Record<string, unknown>): Promise<RepoWorkspace | null> {
  const repository = readRepository(payload);
  const installationId = readInstallationId(payload);
  if (!repository || !installationId) return null;
  const loadedRepo = await loadTrackedRepo(env, repository.repoId);
  if (!loadedRepo.ok) return null;
  const repo = loadedRepo.repo;
  if (repo.meta.githubInstallationId !== installationId) {
    return null;
  }
  return repo;
}

function branchFromRef(ref: unknown): string | null {
  return typeof ref === "string" && ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : null;
}

function repoMetaWithDeliveredIdentity(repo: RepoMeta, repository: ReturnType<typeof readRepository>): RepoMeta {
  if (!repository || repo.githubFullName === repository.fullName) return repo;
  return {
    ...repo,
    githubFullName: repository.fullName,
    repoUrl: githubRepoUrlFromFullName(repository.fullName),
  };
}

function prStateFromPayload(pullRequest: Record<string, unknown>): "open" | "closed" | "merged" | null {
  if (pullRequest.merged === true) return "merged";
  return pullRequest.state === "open" || pullRequest.state === "closed" ? pullRequest.state : null;
}

async function patchEnvGitHubState(
  env: Env,
  meta: EnvMeta,
  repo: RepoMeta,
  overrides: Partial<EnvMeta>,
): Promise<EnvMeta | null> {
  const nextMeta: EnvMeta = {
    ...meta,
    ...overrides,
  };
  nextMeta.branchStatus = deriveGitHubEnvBranchStatus(nextMeta, repo);
  await getEnvLifecycleStub(env, meta.slug).recordStopWorkspaceSynced(
    buildEnvScmMetaPatch(nextMeta),
    { clearError: overrides.githubPublishStatus !== "attention" && overrides.workspaceNeedsAttention !== true },
  );
  return await projectAndPersistEnvSummary(env, getHub(env), meta.slug);
}

async function updateRepoDefaultHead(args: {
  env: Env;
  repo: RepoWorkspace;
  fullName: string;
  defaultBranch: string;
  headSha: string;
  beforeSha?: string | null;
  attempt?: number;
}): Promise<RepoMeta> {
  const previous = args.repo.meta;
  const mainChanged = previous.githubDefaultBranchHeadSha !== args.headSha;
  const nextGitStatus = mainChanged ? "pending" : previous.gitStatus;
  const nextGitError = mainChanged ? null : previous.gitError;
  const patch = await patchRepoDefaultHeadIfCurrent({
    env: args.env,
    workspace: args.repo.workspace,
    expected: repoDefaultHeadIdentityFromMeta(previous),
    next: {
      githubFullName: args.fullName,
      repoUrl: githubRepoUrlFromFullName(args.fullName),
      githubDefaultBranch: args.defaultBranch,
      githubDefaultBranchHeadSha: args.headSha,
      gitStatus: nextGitStatus,
      gitError: nextGitError,
    },
  });
  const nextMeta = patch.repo ?? previous;
  if (patch.conflict) {
    const reloaded = await loadTrackedRepo(args.env, previous.repoId);
    if (!reloaded.ok) return nextMeta;
    const reloadedMeta = reloaded.repo.meta;
    if (
      reloadedMeta.githubFullName === args.fullName &&
      reloadedMeta.githubDefaultBranch === args.defaultBranch &&
      reloadedMeta.githubDefaultBranchHeadSha === args.headSha
    ) {
      return reloadedMeta;
    }
    if (
      (args.attempt ?? 0) === 0 &&
      args.beforeSha &&
      reloadedMeta.githubDefaultBranchHeadSha === args.beforeSha
    ) {
      return await updateRepoDefaultHead({
        ...args,
        repo: reloaded.repo,
        attempt: 1,
      });
    }
    return reloadedMeta;
  }
  if (!patch.changed) return nextMeta;
  const hub = getHub(args.env);
  await hub.broadcastRepoUpsert(projectRepoSummary(nextMeta));
  if (patch.mainChanged) {
    await hub.broadcastRepoMainChange(
      nextMeta.repoId,
      nextMeta.repoUrl,
      previous.githubDefaultBranchHeadSha ?? null,
      nextMeta.githubDefaultBranchHeadSha,
      null,
    );
  }
  return nextMeta;
}

function tillerTrailers(message: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of message.split(/\r?\n/)) {
    const match = /^Tiller-([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match) trailers[match[1]] = match[2] ?? "";
  }
  return trailers;
}

async function readCommitMessage(env: Env, repo: RepoMeta, sha: string): Promise<string | null> {
  const githubRepo = canonicalizeGitHubRepo(repo.githubFullName, { allowOwnerRepo: true });
  const token = await mintGitHubInstallationToken(env, githubRepo, { access: "write" });
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}/commits/${encodeURIComponent(sha)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.token}`,
      "User-Agent": "tiller-hub",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) return null;
  const body = await response.json<Record<string, unknown>>().catch(() => ({}));
  const commit = isRecord(body) && isRecord(body.commit) ? body.commit : null;
  return typeof commit?.message === "string" ? commit.message : null;
}

async function tryAdoptPendingPublish(args: {
  env: Env;
  meta: EnvMeta;
  repo: RepoMeta;
  branchHeadSha: string;
}): Promise<boolean> {
  const lifecycle = getEnvLifecycleStub(args.env, args.meta.slug);
  const operation = await lifecycle.getGitHubPublishOperation();
  if (
    !operation ||
    operation.operationId !== args.meta.githubPublishOperationId ||
    operation.envSlug !== args.meta.slug ||
    operation.repoId !== args.meta.repoId
  ) {
    return false;
  }

  const message = await readCommitMessage(args.env, args.repo, args.branchHeadSha);
  if (!message) return false;
  const trailers = tillerTrailers(message);
  const expectedHmac = await hmacHex(operation.hmacKey, adoptionPayload({
    envSlug: operation.envSlug,
    operationId: operation.operationId,
    workspaceHash: operation.workspaceHash,
    expectedPriorHead: operation.expectedPriorHead,
    baseCommitSha: operation.baseCommitSha,
  }));
  if (
    trailers["Env-Slug"] !== operation.envSlug ||
    trailers["Operation-Id"] !== operation.operationId ||
    trailers["Workspace-Hash"] !== operation.workspaceHash ||
    trailers["Expected-Prior-Head"] !== (operation.expectedPriorHead ?? "(none)") ||
    trailers["Base-Commit"] !== operation.baseCommitSha ||
    trailers["Adoption-Hmac"] !== expectedHmac
  ) {
    return false;
  }

  const result = await handleGitHubDraftPrPublishResult({
    env: args.env,
    slug: args.meta.slug,
    operationId: operation.operationId,
    body: {
      status: "published",
      branchHeadSha: args.branchHeadSha,
      workspaceHash: operation.workspaceHash,
      callbackToken: operation.callbackToken,
      commitCreated: true,
      startedWorkspaceHash: operation.workspaceHash,
      endingWorkspaceHash: operation.workspaceHash,
    },
  });
  return result.status < 400;
}

async function handlePushEvent(env: Env, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repo = await loadMatchedRepo(env, payload);
  if (!repo) return { ok: true, ignored: "repo_not_tracked" };
  const repository = readRepository(payload);
  const branch = branchFromRef(payload.ref);
  const headSha = typeof payload.after === "string" ? payload.after : null;
  const beforeSha = typeof payload.before === "string" ? payload.before : null;
  if (!branch || !headSha || headSha === ZERO_SHA) return { ok: true, ignored: "unsupported_push" };

  const defaultBranch = repository?.defaultBranch ?? repo.meta.githubDefaultBranch;
  if (defaultBranch && branch === defaultBranch && repository) {
    const nextRepo = await updateRepoDefaultHead({
      env,
      repo,
      fullName: repository.fullName,
      defaultBranch,
      headSha,
      beforeSha,
    });
    return { ok: true, repoId: nextRepo.repoId, defaultBranchHeadSha: nextRepo.githubDefaultBranchHeadSha };
  }

  const repoMeta = repoMetaWithDeliveredIdentity(repo.meta, repository);
  const envs = await listEnvViews(env);
  const matchedEnv = envs.find((candidate) =>
    candidate.repoId === repoMeta.repoId && candidate.githubBranch === branch
  );
  if (!matchedEnv) return { ok: true, ignored: "env_branch_not_tracked" };

  if (matchedEnv.githubPublishOperationId && matchedEnv.githubPublishStatus === "publishing") {
    const adopted = await tryAdoptPendingPublish({
      env,
      meta: matchedEnv,
      repo: repoMeta,
      branchHeadSha: headSha,
    });
    return { ok: true, envSlug: matchedEnv.slug, adopted };
  }

  if (matchedEnv.githubHeadCommitSha && matchedEnv.githubHeadCommitSha === headSha) {
    return { ok: true, envSlug: matchedEnv.slug, ignored: "known_head" };
  }

  await patchEnvGitHubState(env, matchedEnv, repoMeta, {
    githubHeadCommitSha: headSha,
    githubPublishStatus: "attention",
    githubPublishError: "GitHub branch moved outside Tiller. Review the branch before publishing again.",
    workspaceNeedsAttention: true,
  });
  return { ok: true, envSlug: matchedEnv.slug, attention: true };
}

async function handlePullRequestEvent(env: Env, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repo = await loadMatchedRepo(env, payload);
  if (!repo) return { ok: true, ignored: "repo_not_tracked" };
  const repository = readRepository(payload);
  const repoMeta = repoMetaWithDeliveredIdentity(repo.meta, repository);
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  if (!pullRequest) return { ok: true, ignored: "missing_pull_request" };
  const prNumber = Number.isInteger(pullRequest.number) ? pullRequest.number as number : null;
  const htmlUrl = typeof pullRequest.html_url === "string" ? pullRequest.html_url : null;
  const state = prStateFromPayload(pullRequest);
  const mergedAt = typeof pullRequest.merged_at === "string" ? pullRequest.merged_at : null;
  const head = isRecord(pullRequest.head) ? pullRequest.head : {};
  const headRef = typeof head.ref === "string" ? head.ref : null;
  const headSha = typeof head.sha === "string" ? head.sha : null;
  if (!prNumber || !state) return { ok: true, ignored: "unsupported_pull_request" };

  const envs = await listEnvViews(env);
  const matchedEnv = envs.find((candidate) =>
    candidate.repoId === repoMeta.repoId &&
    (candidate.githubPrNumber === prNumber || (headRef && candidate.githubBranch === headRef))
  );
  if (!matchedEnv) return { ok: true, ignored: "env_pr_not_tracked" };

  const projected = await patchEnvGitHubState(env, matchedEnv, repoMeta, {
    githubPrNumber: prNumber,
    githubPrUrl: htmlUrl ?? matchedEnv.githubPrUrl,
    githubPrState: state,
    githubMergedAt: state === "merged" ? mergedAt ?? nowIso() : null,
    githubHeadCommitSha: headSha ?? matchedEnv.githubHeadCommitSha,
    githubPublishStatus: state === "merged" ? "merged" : matchedEnv.githubPublishStatus,
    githubPublishError: state === "merged" ? null : matchedEnv.githubPublishError,
  });

  return {
    ok: true,
    envSlug: matchedEnv.slug,
    prNumber,
    prState: projected?.githubPrState ?? state,
  };
}

export async function handleGitHubWebhook(
  env: Env,
  request: Request,
  rawBody: ArrayBuffer,
): Promise<RouteResult> {
  const secret = await getSecret(env, "GITHUB_APP_WEBHOOK_SECRET", { fresh: true });
  if (!secret) {
    return {
      status: 409,
      body: { error: "GitHub webhook secret is not configured.", code: "github_webhook_not_configured" },
    };
  }
  if (!(await verifySignature(secret, rawBody, request.headers.get("X-Hub-Signature-256")))) {
    return { status: 401, body: { error: "Invalid GitHub webhook signature.", code: "github_webhook_signature_invalid" } };
  }

  const deliveryId = request.headers.get("X-GitHub-Delivery")?.trim() ?? "";
  const eventName = request.headers.get("X-GitHub-Event")?.trim() ?? "";
  if (!deliveryId || !eventName) {
    return { status: 400, body: { error: "Missing GitHub webhook delivery headers.", code: "github_webhook_headers_missing" } };
  }
  if (!(await claimDelivery(env, deliveryId, eventName))) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const payloadText = new TextDecoder().decode(rawBody);
  const payload = JSON.parse(payloadText) as unknown;
  if (!isRecord(payload)) {
    return { status: 400, body: { error: "Invalid GitHub webhook payload.", code: "github_webhook_payload_invalid" } };
  }

  if (eventName === "push") {
    return { status: 200, body: await handlePushEvent(env, payload) };
  }
  if (eventName === "pull_request") {
    return { status: 200, body: await handlePullRequestEvent(env, payload) };
  }
  return { status: 200, body: { ok: true, ignored: "unsupported_event" } };
}
