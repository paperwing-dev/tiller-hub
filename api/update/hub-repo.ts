import { getLocationHintOptions } from "../helpers";
import type { Env } from "../types";
import {
  listGitHubAppRepositories,
  mintGitHubInstallationToken,
  type GitHubAppRepositorySelection,
} from "../github/app";
import { canonicalizeGitHubRepo } from "../github/repo";
import {
  getBuildDiagnostics,
  parseTillerUpdateMetadata,
  UPDATE_METADATA_PATH,
} from "./metadata";
import type {
  HubUpdateRepoCandidate,
  HubUpdateRepoDetected,
  HubUpdateRepoState,
} from "./types";

const CONFIG_KEYS = {
  status: "HUB_UPDATE_REPO_STATUS",
  owner: "HUB_UPDATE_REPO_OWNER",
  repo: "HUB_UPDATE_REPO_REPO",
  repoId: "HUB_UPDATE_REPO_ID",
  installationId: "HUB_UPDATE_REPO_INSTALLATION_ID",
  branch: "HUB_UPDATE_REPO_BRANCH",
  label: "HUB_UPDATE_REPO_LABEL",
  lastDetectedAt: "HUB_UPDATE_REPO_LAST_DETECTED_AT",
  detectedBy: "HUB_UPDATE_REPO_DETECTED_BY",
  candidates: "HUB_UPDATE_REPO_CANDIDATES",
} as const;

const AUTO_DETECT_RETRY_MS = 5 * 60 * 1000;

type ConfigStore = {
  getAllConfig(): Promise<Record<string, string>> | Record<string, string>;
  setConfig(key: string, value: string): Promise<void> | void;
};

interface GitHubContentResponse {
  type?: string;
  content?: string;
  encoding?: string;
}

function getConfigStore(env: Env): ConfigStore {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as ConfigStore;
}

function nowIso(): string {
  return new Date().toISOString();
}

function shouldAutoDetect(state: HubUpdateRepoState): boolean {
  if (state.status === "detected") return false;
  if (state.status === "not_checked") return true;

  const lastDetectedAt = Date.parse(state.lastDetectedAt ?? "");
  if (!Number.isFinite(lastDetectedAt)) return true;
  return Date.now() - lastDetectedAt >= AUTO_DETECT_RETRY_MS;
}

function readPositiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseCandidates(value: string | undefined): HubUpdateRepoCandidate[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHubUpdateRepoCandidate);
  } catch {
    return [];
  }
}

function isHubUpdateRepoCandidate(value: unknown): value is HubUpdateRepoCandidate {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HubUpdateRepoCandidate>;
  return typeof item.owner === "string" &&
    typeof item.repo === "string" &&
    typeof item.fullName === "string" &&
    typeof item.label === "string" &&
    typeof item.repoId === "number" &&
    typeof item.installationId === "number" &&
    typeof item.branch === "string" &&
    typeof item.private === "boolean" &&
    (typeof item.defaultBranch === "string" || item.defaultBranch === null) &&
    typeof item.sourceId === "string";
}

export async function readHubUpdateRepoState(env: Env): Promise<HubUpdateRepoState> {
  if (!(env as unknown as { HUB?: unknown }).HUB) {
    return { status: "not_checked", lastDetectedAt: null };
  }
  const config = await getConfigStore(env).getAllConfig();
  const status = config[CONFIG_KEYS.status];
  const lastDetectedAt = config[CONFIG_KEYS.lastDetectedAt]?.trim() || null;

  if (status === "detected") {
    const repoId = readPositiveInteger(config[CONFIG_KEYS.repoId]);
    const installationId = readPositiveInteger(config[CONFIG_KEYS.installationId]);
    const owner = config[CONFIG_KEYS.owner]?.trim();
    const repo = config[CONFIG_KEYS.repo]?.trim();
    const branch = config[CONFIG_KEYS.branch]?.trim();
    if (repoId && installationId && owner && repo && branch && lastDetectedAt) {
      const fullName = `${owner}/${repo}`;
      return {
        status: "detected",
        owner,
        repo,
        fullName,
        label: config[CONFIG_KEYS.label]?.trim() || fullName,
        repoId,
        installationId,
        branch,
        lastDetectedAt,
        detectedBy: config[CONFIG_KEYS.detectedBy] === "manual" || config[CONFIG_KEYS.detectedBy] === "selection"
          ? config[CONFIG_KEYS.detectedBy]
          : "auto",
      };
    }
  }

  if (status === "missing") {
    return { status: "missing", lastDetectedAt };
  }

  if (status === "ambiguous" && lastDetectedAt) {
    return {
      status: "ambiguous",
      lastDetectedAt,
      candidates: parseCandidates(config[CONFIG_KEYS.candidates]),
    };
  }

  return { status: "not_checked", lastDetectedAt: null };
}

async function writeState(env: Env, values: Record<string, string>): Promise<void> {
  const store = getConfigStore(env);
  for (const [key, value] of Object.entries(values)) {
    await store.setConfig(key, value);
  }
}

async function persistDetected(
  env: Env,
  candidate: HubUpdateRepoCandidate,
  detectedBy: HubUpdateRepoDetected["detectedBy"],
  detectedAt = nowIso(),
): Promise<HubUpdateRepoDetected> {
  await writeState(env, {
    [CONFIG_KEYS.status]: "detected",
    [CONFIG_KEYS.owner]: candidate.owner,
    [CONFIG_KEYS.repo]: candidate.repo,
    [CONFIG_KEYS.repoId]: String(candidate.repoId),
    [CONFIG_KEYS.installationId]: String(candidate.installationId),
    [CONFIG_KEYS.branch]: candidate.branch,
    [CONFIG_KEYS.label]: candidate.label,
    [CONFIG_KEYS.lastDetectedAt]: detectedAt,
    [CONFIG_KEYS.detectedBy]: detectedBy,
    [CONFIG_KEYS.candidates]: "",
  });

  return {
    status: "detected",
    owner: candidate.owner,
    repo: candidate.repo,
    fullName: candidate.fullName,
    label: candidate.label,
    repoId: candidate.repoId,
    installationId: candidate.installationId,
    branch: candidate.branch,
    lastDetectedAt: detectedAt,
    detectedBy,
  };
}

async function persistMissing(env: Env, detectedAt = nowIso()): Promise<HubUpdateRepoState> {
  await writeState(env, {
    [CONFIG_KEYS.status]: "missing",
    [CONFIG_KEYS.lastDetectedAt]: detectedAt,
    [CONFIG_KEYS.detectedBy]: "auto",
    [CONFIG_KEYS.candidates]: "",
  });
  return { status: "missing", lastDetectedAt: detectedAt };
}

async function persistAmbiguous(
  env: Env,
  candidates: HubUpdateRepoCandidate[],
  detectedAt = nowIso(),
): Promise<HubUpdateRepoState> {
  await writeState(env, {
    [CONFIG_KEYS.status]: "ambiguous",
    [CONFIG_KEYS.lastDetectedAt]: detectedAt,
    [CONFIG_KEYS.detectedBy]: "auto",
    [CONFIG_KEYS.candidates]: JSON.stringify(candidates),
  });
  return { status: "ambiguous", lastDetectedAt: detectedAt, candidates };
}

function branchProbeOrder(repository: GitHubAppRepositorySelection): string[] {
  const probes = [
    getBuildDiagnostics().workersCiBranch,
    repository.defaultBranch,
  ].filter((value): value is string => Boolean(value?.trim()));
  return [...new Set(probes.map((value) => value.trim()))];
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/\s+/g, "");
  return atob(normalized);
}

export async function fetchRepoUpdateMetadata(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<ReturnType<typeof parseTillerUpdateMetadata>> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${UPDATE_METADATA_PATH}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tiller-hub",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub update marker lookup failed for ${owner}/${repo}@${branch}: HTTP ${response.status}`);
  }
  const body = await response.json<GitHubContentResponse>();
  if (body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
    return null;
  }
  try {
    return parseTillerUpdateMetadata(JSON.parse(decodeBase64(body.content)) as unknown);
  } catch {
    return null;
  }
}

async function detectCandidateForRepo(
  env: Env,
  repository: GitHubAppRepositorySelection,
): Promise<HubUpdateRepoCandidate | null> {
  const repo = canonicalizeGitHubRepo(repository.fullName, { allowOwnerRepo: true });
  const installationToken = await mintGitHubInstallationToken(env, repo, { access: "write" });

  for (const branch of branchProbeOrder(repository)) {
    const marker = await fetchRepoUpdateMetadata(installationToken.token, repo.owner, repo.repo, branch);
    if (!marker) continue;
    return {
      owner: repo.owner,
      repo: repo.repo,
      fullName: repo.fullName,
      label: `${repo.fullName} (${branch})`,
      repoId: repository.repositoryId,
      installationId: repository.installationId,
      branch,
      private: repository.private,
      defaultBranch: repository.defaultBranch,
      sourceId: marker.sourceId,
    };
  }

  return null;
}

export async function detectHubUpdateRepo(
  env: Env,
  options: { detectedBy?: "auto" | "manual" } = {},
): Promise<HubUpdateRepoState> {
  const result = await listGitHubAppRepositories(env);
  const candidates: HubUpdateRepoCandidate[] = [];
  const seenRepoIds = new Set<number>();

  for (const repository of result.repositories) {
    if (seenRepoIds.has(repository.repositoryId)) continue;
    seenRepoIds.add(repository.repositoryId);
    const candidate = await detectCandidateForRepo(env, repository);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  if (candidates.length === 1) {
    return persistDetected(env, candidates[0], options.detectedBy ?? "auto");
  }
  if (candidates.length === 0) {
    return persistMissing(env);
  }
  return persistAmbiguous(env, candidates);
}

export async function resolveHubUpdateRepoState(
  env: Env,
  options: { autoDetect?: boolean } = {},
): Promise<HubUpdateRepoState> {
  const current = await readHubUpdateRepoState(env);
  if (!options.autoDetect || !shouldAutoDetect(current)) return current;
  if (!(env as unknown as { HUB?: unknown }).HUB) return current;

  try {
    return await detectHubUpdateRepo(env, { detectedBy: "auto" });
  } catch {
    return current;
  }
}

export async function selectHubUpdateRepo(
  env: Env,
  input: {
    repoId?: unknown;
    installationId?: unknown;
    fullName?: unknown;
    branch?: unknown;
  },
): Promise<HubUpdateRepoState> {
  if (
    typeof input.repoId !== "number" ||
    typeof input.installationId !== "number" ||
    typeof input.fullName !== "string" ||
    typeof input.branch !== "string"
  ) {
    throw new Error("repoId, installationId, fullName, and branch are required.");
  }

  const repo = canonicalizeGitHubRepo(input.fullName, { allowOwnerRepo: true });
  const installationToken = await mintGitHubInstallationToken(env, repo, { access: "write" });
  const marker = await fetchRepoUpdateMetadata(installationToken.token, repo.owner, repo.repo, input.branch);
  if (!marker) {
    throw new Error(`${repo.fullName}@${input.branch} is not a Tiller deploy-button hub repo.`);
  }

  return persistDetected(env, {
    owner: repo.owner,
    repo: repo.repo,
    fullName: repo.fullName,
    label: `${repo.fullName} (${input.branch})`,
    repoId: input.repoId,
    installationId: input.installationId,
    branch: input.branch,
    private: false,
    defaultBranch: null,
    sourceId: marker.sourceId,
  }, "selection");
}
