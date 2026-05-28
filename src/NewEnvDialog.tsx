import React, { useEffect, useState } from "react";
import type { CodexAuthPreference, EnvHarness, RepoMeta } from "../api/types";
import type { GitHubRepositorySelection } from "./api";
import { getHarnessBadgeLabel } from "./env-harness";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";
import { githubRepositoryKey, useGitHubRepositories } from "./useGitHubRepositories";

// ── NewRepoDialog ────────────────────────────────────────────────

interface NewRepoDialogProps {
  onClose: () => void;
  hubUrl: string;
  repos: RepoMeta[];
  onCreate: (selection: GitHubRepositorySelection) => Promise<void>;
}

export function NewRepoDialog({ onClose, hubUrl, repos, onCreate }: NewRepoDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const githubRepositories = useGitHubRepositories(hubUrl);
  const { repositories, warnings, loading: loadingRepositories } = githubRepositories;
  const existingRepoIds = new Set(repos.map((repo) => repo.repoId));
  const visibleRepositories = repositories.filter((repo) =>
    repo.fullName.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = repositories.find((repo) => repoKey(repo) === selectedKey) ?? null;

  useEffect(() => {
    setError(githubRepositories.error);
  }, [githubRepositories.error]);

  useEffect(() => {
    const firstAvailable = repositories.find((repo) => !existingRepoIds.has(String(repo.repositoryId)));
    setSelectedKey(firstAvailable ? repoKey(firstAvailable) : "");
  }, [repositories, repos.map((repo) => repo.repoId).join("\n")]);

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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search selected repositories"
            autoFocus
            disabled={loading || loadingRepositories}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          />
          <div className="mt-3 max-h-64 overflow-auto rounded border border-[#d0d7de] bg-white">
            {loadingRepositories ? (
              <div className="px-3 py-3 text-xs text-[#57606a]">Loading repositories...</div>
            ) : visibleRepositories.length > 0 ? (
              visibleRepositories.map((repo) => {
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

export function NewEnvDialog({
  onClose,
  isLocalDev,
  deploymentMode,
  hostConnected,
  hostGatewayAvailable = hostConnected,
  enabledHarnesses,
  repo,
  onCreate,
}: NewEnvDialogProps) {
  const [harness, setHarness] = useState<EnvHarness>(enabledHarnesses[0] ?? "claude-code");
  const [backend, setBackend] = useState<"cf" | "host">(
    getInitialEnvBackendSelection({ isLocalDev, deploymentMode, hostConnected, hostGatewayAvailable }),
  );
  const [codexAuthPreference, setCodexAuthPreference] = useState<CodexAuthPreference>("auto");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoMainReady = isRepoMainReady(repo);
  const repoMainDetail = getRepoMainStatusDetail(repo);

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
    if (deploymentMode === "hosted") {
      setCodexAuthPreference("api-key");
    }
  }, [deploymentMode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLoading(true);
    setError(null);
    try {
      await onCreate(backend, harness, harness === "codex" ? codexAuthPreference : undefined);
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
          {harness === "codex" ? (
            <div className="mt-2 grid gap-2">
              <label className="block text-xs font-medium text-[#57606a]">
                Codex Auth
              </label>
              <select
                value={codexAuthPreference}
                onChange={(e) => setCodexAuthPreference(e.target.value as CodexAuthPreference)}
                disabled={loading}
                className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
              >
                <option value="auto" disabled={deploymentMode === "hosted"}>Auto</option>
                <option value="subscription" disabled={deploymentMode === "hosted"}>Subscription Gateway</option>
                <option value="api-key">API key</option>
              </select>
              <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[11px] text-[#6e7781]">
                {deploymentMode === "hosted"
                  ? "Hosted Tiller uses OPENAI_API_KEY for Codex containers."
                  : codexAuthPreference === "subscription"
                  ? "Requires connected subscription auth and a healthy Subscription Gateway route."
                  : codexAuthPreference === "api-key"
                    ? "Uses only the configured API key."
                    : "Prefers subscription auth through the Subscription Gateway, then falls back to the API key with a warning."}
              </div>
            </div>
          ) : harness === "opencode" ? (
            <div className="mt-2 rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[11px] text-[#6e7781]">
              OpenCode environments use Tiller&apos;s built-in Workers AI hub proxy and stay pinned to Kimi K2.5.
              Choose the backend explicitly based on whether you want Cloudflare Containers or your connected Tiller
              Tiller Self Host.
            </div>
          ) : (
            <div className="mt-2 rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[11px] text-[#6e7781]">
              Claude environments choose auth automatically from your configured subscription token or Anthropic API
              key.
            </div>
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
              disabled={loading || !repoMainReady}
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
