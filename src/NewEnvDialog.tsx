import React, { useEffect, useMemo, useState } from "react";
import type { CodexAuthPreference, EnvHarness, RepoMeta } from "../api/types";
import type { GitHubRepositorySelection } from "./api";
import { getHarnessBadgeLabel } from "./env-harness";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";
import { githubRepositoryKey, useGitHubRepositories } from "./useGitHubRepositories";

// ── NewRepoDialog ────────────────────────────────────────────────

export const REPOSITORY_PAGE_SIZE = 5;

export function getRepositoryPagination(
  totalItems: number,
  requestedPage: number,
  pageSize = REPOSITORY_PAGE_SIZE,
): {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  hasPrevious: boolean;
  hasNext: boolean;
} {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const safeTotal = Math.max(0, totalItems);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = Math.min((page - 1) * safePageSize, safeTotal);
  const endIndex = Math.min(startIndex + safePageSize, safeTotal);
  return {
    page,
    totalPages,
    startIndex,
    endIndex,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

interface NewRepoDialogProps {
  onClose: () => void;
  hubUrl: string;
  repos: RepoMeta[];
  onCreate: (selection: GitHubRepositorySelection) => Promise<void>;
}

export function NewRepoDialog({ onClose, hubUrl, repos, onCreate }: NewRepoDialogProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const githubRepositories = useGitHubRepositories(hubUrl);
  const { repositories, warnings, loading: loadingRepositories } = githubRepositories;
  const existingRepoIds = useMemo(() => new Set(repos.map((repo) => repo.repoId)), [repos]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRepositories = useMemo(
    () => repositories.filter((repo) => repo.fullName.toLowerCase().includes(normalizedQuery)),
    [repositories, normalizedQuery],
  );
  const pagination = getRepositoryPagination(visibleRepositories.length, page);
  const pageRepositories = useMemo(
    () => visibleRepositories.slice(pagination.startIndex, pagination.endIndex),
    [pagination.endIndex, pagination.startIndex, visibleRepositories],
  );
  const selected = pageRepositories.find((repo) => repoKey(repo) === selectedKey) ?? null;
  const canPage = !loading && !loadingRepositories;

  useEffect(() => {
    setPage((current) => getRepositoryPagination(visibleRepositories.length, current).page);
  }, [visibleRepositories.length]);

  useEffect(() => {
    const currentSelection = pageRepositories.find((repo) => repoKey(repo) === selectedKey);
    if (currentSelection && !existingRepoIds.has(String(currentSelection.repositoryId))) return;

    const firstAvailable = pageRepositories.find((repo) => !existingRepoIds.has(String(repo.repositoryId)));
    setSelectedKey(firstAvailable ? repoKey(firstAvailable) : "");
  }, [existingRepoIds, pageRepositories, selectedKey]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setPage(1);
  };

  const goToPreviousPage = () => {
    setPage(getRepositoryPagination(visibleRepositories.length, pagination.page - 1).page);
  };
  const goToNextPage = () => {
    setPage(getRepositoryPagination(visibleRepositories.length, pagination.page + 1).page);
  };

  useEffect(() => {
    setError(githubRepositories.error);
  }, [githubRepositories.error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || existingRepoIds.has(String(selected.repositoryId))) return;

    setLoading(true);
    setError(null);
    try {
      await onCreate(selected);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="px-5 py-4 border-b border-[#d0d7de]">
          <h3 className="text-sm font-semibold text-[#24292f]">Add Repository</h3>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4">
          <label className="block text-xs font-medium text-[#57606a] mb-1.5">
            GitHub Repository
          </label>
          <input
            type="text"
            value={query}
            onChange={handleQueryChange}
            placeholder="Search selected repositories"
            autoFocus
            disabled={loading || loadingRepositories}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          />
          <div className="mt-3 max-h-64 overflow-auto rounded border border-[#d0d7de] bg-white">
            {loadingRepositories ? (
              <div className="px-3 py-3 text-xs text-[#57606a]">Loading repositories...</div>
            ) : visibleRepositories.length > 0 ? (
              pageRepositories.map((repo) => {
                const key = repoKey(repo);
                const alreadyAdded = existingRepoIds.has(String(repo.repositoryId));
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-center gap-3 border-b border-[#d0d7de] px-3 py-2 last:border-b-0 ${alreadyAdded ? "bg-[#f6f8fa] opacity-60" : "hover:bg-[#f6f8fa]"}`}
                  >
                    <input
                      type="radio"
                      name="github-repo"
                      checked={selectedKey === key}
                      onChange={() => setSelectedKey(key)}
                      disabled={loading || alreadyAdded}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[#24292f]">{repo.fullName}</span>
                      <span className="block truncate text-[11px] text-[#6e7781]">
                        {alreadyAdded ? "Already added" : repo.private ? "Private" : "Public"}
                        {repo.defaultBranch ? ` · ${repo.defaultBranch}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-[#57606a]">
                {repositories.length === 0 ? "No repositories available" : "No repositories match your search"}
              </div>
            )}
          </div>
          {visibleRepositories.length > 0 && pagination.totalPages > 1 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#57606a]">
              <span>
                {pagination.startIndex + 1}-{pagination.endIndex} of {visibleRepositories.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goToPreviousPage}
                  disabled={!canPage || !pagination.hasPrevious}
                  className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-[#57606a] transition-colors hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="whitespace-nowrap">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  type="button"
                  onClick={goToNextPage}
                  disabled={!canPage || !pagination.hasNext}
                  className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-[#57606a] transition-colors hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
          {warnings.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              {warnings[0]?.message}
            </p>
          )}
          {error && (
            <p className="mt-2 text-xs text-red-600">{error}</p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || loadingRepositories || !selected || existingRepoIds.has(String(selected.repositoryId))}
              className="text-xs px-3 py-1.5 rounded bg-[#0969da] hover:bg-[#0a5bc4] text-white font-medium transition-colors disabled:opacity-40"
            >
              {loading ? "Adding..." : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function repoKey(repo: GitHubRepositorySelection): string {
  return githubRepositoryKey(repo);
}

// ── NewEnvDialog ─────────────────────────────────────────────────

interface NewEnvDialogProps {
  onClose: () => void;
  isLocalDev: boolean;
  deploymentMode: "hosted" | "self-host";
  hostConnected: boolean;
  hostGatewayAvailable?: boolean;
  hasClaudeSubscription?: boolean;
  hasAnthropicKey?: boolean;
  hasChatGPTAuth?: boolean;
  hasOpenAIKey?: boolean;
  workersAiConfigured?: boolean;
  enabledHarnesses: EnvHarness[];
  repo: RepoMeta;
  onCreate: (
    backend: "cf" | "host",
    harness: EnvHarness,
    codexAuthPreference?: CodexAuthPreference,
  ) => Promise<void>;
}

function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

export function getInitialEnvBackendSelection(
  options: { isLocalDev: boolean; deploymentMode?: "hosted" | "self-host"; hostConnected: boolean; hostGatewayAvailable?: boolean },
): "cf" | "host" {
  if (!options.isLocalDev && options.deploymentMode === "hosted") return "cf";
  const gatewayAvailable = options.hostGatewayAvailable ?? options.hostConnected;
  return options.isLocalDev || (options.hostConnected && gatewayAvailable) ? "host" : "cf";
}

export function getEffectiveCodexAuthPreference(
  options: {
    backend: "cf" | "host";
    deploymentMode: "hosted" | "self-host";
  },
): CodexAuthPreference {
  if (options.backend === "host") return "auto";
  if (options.deploymentMode === "hosted") return "api-key";
  return "auto";
}

export function getHarnessCredentialError(options: {
  harness: EnvHarness;
  backend: "cf" | "host";
  deploymentMode: "hosted" | "self-host";
  hasClaudeSubscription?: boolean;
  hasAnthropicKey?: boolean;
  hasChatGPTAuth?: boolean;
  hasOpenAIKey?: boolean;
  workersAiConfigured?: boolean;
}): string | null {
  if (options.harness === "claude-code") {
    if (options.backend === "cf") {
      return options.hasAnthropicKey ? null : "Claude Code requires ANTHROPIC_API_KEY for Cloudflare Containers.";
    }
    return options.hasClaudeSubscription || options.hasAnthropicKey
      ? null
      : "Claude Code requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.";
  }

  if (options.harness === "codex") {
    if (options.deploymentMode === "hosted") {
      return options.hasOpenAIKey ? null : "Codex requires OPENAI_API_KEY for Hosted Tiller.";
    }
    return options.hasChatGPTAuth || options.hasOpenAIKey
      ? null
      : "Codex requires a Codex subscription login or OPENAI_API_KEY.";
  }

  if (options.harness === "opencode") {
    return options.workersAiConfigured ? null : "OpenCode requires the Workers AI binding.";
  }

  return null;
}

export function NewEnvDialog({
  onClose,
  isLocalDev,
  deploymentMode,
  hostConnected,
  hostGatewayAvailable = hostConnected,
  hasClaudeSubscription = false,
  hasAnthropicKey = false,
  hasChatGPTAuth = false,
  hasOpenAIKey = false,
  workersAiConfigured = false,
  enabledHarnesses,
  repo,
  onCreate,
}: NewEnvDialogProps) {
  const [harness, setHarness] = useState<EnvHarness>(enabledHarnesses[0] ?? "claude-code");
  const [backend, setBackend] = useState<"cf" | "host">(
    getInitialEnvBackendSelection({ isLocalDev, deploymentMode, hostConnected, hostGatewayAvailable }),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoMainReady = isRepoMainReady(repo);
  const repoMainDetail = getRepoMainStatusDetail(repo);
  const credentialError = getHarnessCredentialError({
    harness,
    backend,
    deploymentMode,
    hasClaudeSubscription,
    hasAnthropicKey,
    hasChatGPTAuth,
    hasOpenAIKey,
    workersAiConfigured,
  });
  const visibleError = error ?? credentialError;

  useEffect(() => {
    if (!enabledHarnesses.includes(harness)) {
      setHarness(enabledHarnesses[0] ?? "claude-code");
    }
  }, [enabledHarnesses, harness]);

  useEffect(() => {
    if (isLocalDev) {
      setBackend("host");
    } else if (deploymentMode === "hosted") {
      setBackend("cf");
    } else if (!hostConnected || !hostGatewayAvailable) {
      setBackend("cf");
    }
  }, [deploymentMode, hostConnected, hostGatewayAvailable, isLocalDev]);

  useEffect(() => {
    setError(null);
  }, [backend, harness]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (credentialError) return;

    setLoading(true);
    setError(null);
    try {
      const effectiveCodexAuthPreference = harness === "codex"
        ? getEffectiveCodexAuthPreference({ backend, deploymentMode })
        : undefined;
      await onCreate(backend, harness, effectiveCodexAuthPreference);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="px-5 py-4 border-b border-[#d0d7de]">
          <h3 className="text-sm font-semibold text-[#24292f]">New Environment</h3>
          <p className="text-xs text-[#57606a] mt-0.5">{repoLabel(repo.repoUrl)}</p>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4">
          {!repoMainReady && (
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                {getRepoMainStatusLabel(repo)}
              </div>
              <p className="mt-1 text-xs text-amber-900">
                {repoMainDetail}
              </p>
            </div>
          )}
          <label className="block text-xs font-medium text-[#57606a] mb-1.5">
            Execution Backend
          </label>
          {isLocalDev ? (
            <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
              <p className="text-sm font-medium text-[#24292f]">Tiller Self Host</p>
              <p className="mt-1 text-[11px] text-[#6e7781]">
                This localhost hub only supports Tiller Self Host. Keep <code>tiller host</code> running before starting
                environments.
              </p>
            </div>
          ) : deploymentMode === "hosted" ? (
            <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
              <p className="text-sm font-medium text-[#24292f]">Cloudflare Containers</p>
              <p className="mt-1 text-[11px] text-[#6e7781]">
                Hosted Tiller runs environments on Cloudflare. Switch to Tiller Self Host before using a connected
                machine.
              </p>
            </div>
          ) : (
            <select
              value={backend}
              onChange={(e) => setBackend(e.target.value as "cf" | "host")}
              disabled={loading}
              className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
            >
              <option value="cf">Cloudflare Containers</option>
              <option value="host" disabled={!hostConnected || !hostGatewayAvailable}>Tiller Self Host</option>
            </select>
          )}
          {!isLocalDev && deploymentMode === "self-host" && (!hostConnected || !hostGatewayAvailable) && (
            <p className="mt-1 text-[11px] text-[#9a6700]">Start `tiller host` to use Tiller Self Host.</p>
          )}
          <label className="block text-xs font-medium text-[#57606a] mt-3 mb-1.5">
            Harness
          </label>
          <select
            value={harness}
            onChange={(e) => setHarness(e.target.value as EnvHarness)}
            disabled={loading}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          >
            {enabledHarnesses.map((enabledHarness) => (
              <option key={enabledHarness} value={enabledHarness}>
                {getHarnessBadgeLabel(enabledHarness)}
              </option>
            ))}
          </select>
          {visibleError && (
            <p className="mt-2 text-xs text-red-600">{visibleError}</p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !repoMainReady || Boolean(credentialError)}
              className="text-xs px-3 py-1.5 rounded bg-[#0969da] hover:bg-[#0a5bc4] text-white font-medium transition-colors disabled:opacity-40"
            >
              {loading ? "Creating..." : !repoMainReady ? "Waiting for Main..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
