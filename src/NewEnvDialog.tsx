import React, { useEffect, useState } from "react";
import type { EnvHarness, RepoMeta } from "../api/types";
import { getHarnessBadgeLabel } from "./env-harness";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";

// ── NewRepoDialog ────────────────────────────────────────────────

interface NewRepoDialogProps {
  onClose: () => void;
  onCreate: (repoUrl: string) => Promise<void>;
}

export function NewRepoDialog({ onClose, onCreate }: NewRepoDialogProps) {
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = repoUrl.trim();
    if (!url) return;

    setLoading(true);
    setError(null);
    try {
      await onCreate(url);
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
            Repository URL
          </label>
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/you/repo"
            autoFocus
            disabled={loading}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          />
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
              disabled={loading || !repoUrl.trim()}
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

// ── NewEnvDialog ─────────────────────────────────────────────────

interface NewEnvDialogProps {
  onClose: () => void;
  isLocalDev: boolean;
  hostConnected: boolean;
  enabledHarnesses: EnvHarness[];
  repo: RepoMeta;
  onCreate: (
    backend: "cf" | "host",
    harness: EnvHarness,
  ) => Promise<void>;
}

function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

export function getInitialEnvBackendSelection(
  options: { isLocalDev: boolean; hostConnected: boolean },
): "cf" | "host" {
  return options.isLocalDev || options.hostConnected ? "host" : "cf";
}

export function NewEnvDialog({
  onClose,
  isLocalDev,
  hostConnected,
  enabledHarnesses,
  repo,
  onCreate,
}: NewEnvDialogProps) {
  const [harness, setHarness] = useState<EnvHarness>(enabledHarnesses[0] ?? "claude-code");
  const [backend, setBackend] = useState<"cf" | "host">(
    getInitialEnvBackendSelection({ isLocalDev, hostConnected }),
  );
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
    }
  }, [isLocalDev]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLoading(true);
    setError(null);
    try {
      await onCreate(backend, harness);
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
              <p className="text-sm font-medium text-[#24292f]">Tiller Host</p>
              <p className="mt-1 text-[11px] text-[#6e7781]">
                This localhost hub only supports Tiller Host. Keep <code>tiller host</code> running before starting
                environments.
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
              <option value="host">Tiller Host</option>
            </select>
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
            <div className="mt-2 rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[11px] text-[#6e7781]">
              {backend === "host"
                ? "Host Codex environments use your connected Tiller Host gateway for ChatGPT subscription access."
                : "Cloudflare Codex environments use the OpenAI API key."}
            </div>
          ) : harness === "opencode" ? (
            <div className="mt-2 rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[11px] text-[#6e7781]">
              OpenCode environments use Tiller&apos;s built-in Workers AI hub proxy and stay pinned to Kimi K2.5.
              Choose the backend explicitly based on whether you want Cloudflare Containers or your connected Tiller
              Host.
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
