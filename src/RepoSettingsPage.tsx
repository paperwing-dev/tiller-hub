import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import type { RepoMeta } from "../api/types";
import type { RepoCloudflareMcpStatus, RepoMcpServer, RepoMcpServerInput } from "./api";
import {
  connectRepoCloudflareMcp,
  disconnectRepoCloudflareMcp,
  fetchRepoCloudflareMcpStatus,
  fetchRepoMcpServers,
  putRepoMcpServers,
  setRepoCloudflareMcpEnabled,
} from "./api";
import { useToast } from "./Toast";
import RepoSessionEnvSettings from "./RepoSessionEnvSettings";

const HUB_URL = window.location.origin;
const CLOUDFLARE_MCP_PRESETS = [
  { label: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp" },
];

interface RepoSettingsPageProps {
  repo: RepoMeta;
  onDone: () => void;
}

interface McpServerDraft {
  clientKey: string;
  id?: string;
  label: string;
  url: string;
  enabled: boolean;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-kumo-line bg-kumo-elevated p-5">
      <h3 className="text-base font-semibold text-kumo-strong">{title}</h3>
      <p className="mt-1 text-sm text-kumo-subtle">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function repoLabel(repo: RepoMeta): string {
  return repo.githubFullName || repo.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function draftFromServer(server: RepoMcpServer): McpServerDraft {
  return {
    clientKey: server.id,
    id: server.id,
    label: server.label,
    url: server.url,
    enabled: server.enabled,
  };
}

function newDraft(overrides: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    clientKey: crypto.randomUUID(),
    label: "",
    url: "",
    enabled: true,
    ...overrides,
  };
}

function toServerInput(row: McpServerDraft): RepoMcpServerInput {
  return {
    ...(row.id ? { id: row.id } : {}),
    label: row.label,
    url: row.url,
    enabled: row.enabled,
  };
}

function canonicalUrlForComparison(url: string): string {
  try {
    return new URL(url.trim()).href;
  } catch {
    return url.trim();
  }
}

function statusLabel(status: RepoCloudflareMcpStatus | null): string {
  if (!status) return "Loading";
  if (status.status === "not_connected") return "Not connected";
  if (status.status === "reauth_required") return "Reauth required";
  return status.enabled ? "Enabled" : "Connected";
}

function RepoCloudflareMcpSettings({ repo }: { repo: RepoMeta }) {
  const [status, setStatus] = useState<RepoCloudflareMcpStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToast();

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchRepoCloudflareMcpStatus(HUB_URL, repo.repoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [repo.repoId]);

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const started = await connectRepoCloudflareMcp(HUB_URL, repo.repoId);
      window.location.assign(started.authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function setEnabled(enabled: boolean) {
    setBusy(enabled ? "enable" : "disable");
    setError(null);
    try {
      const next = await setRepoCloudflareMcpEnabled(HUB_URL, repo.repoId, enabled);
      setStatus(next);
      addToast({ title: enabled ? "Cloudflare API MCP enabled" : "Cloudflare API MCP disabled", variant: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setError(null);
    try {
      const next = await disconnectRepoCloudflareMcp(HUB_URL, repo.repoId);
      setStatus(next);
      addToast({ title: "Cloudflare API MCP disconnected", variant: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const connected = status?.connected ?? false;
  const needsReauth = status?.status === "reauth_required";
  const disabled = loading || Boolean(busy);

  return (
    <div className="grid gap-3 rounded-xl border border-kumo-line bg-kumo-recessed p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-kumo-default">Cloudflare API</h4>
            <Badge variant={status?.enabled ? "success" : needsReauth ? "error" : "secondary"}>
              {statusLabel(status)}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-kumo-subtle">
            Enabled sessions launch <span className="font-mono text-kumo-default">tiller_cloudflare_api</span> through Tiller with this repository's connected Cloudflare account.
          </p>
          {status?.account && (
            <p className="mt-1 text-xs text-kumo-subtle">
              Account: {status.account.name || status.account.id || "Connected account"}
            </p>
          )}
          {status?.lastAuthError && <p className="mt-1 text-xs text-kumo-danger">{status.lastAuthError}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void connect()}
            disabled={disabled}
            loading={busy === "connect"}
          >
            {connected ? "Reconnect" : "Connect"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void setEnabled(!status?.enabled)}
            disabled={disabled || !connected || needsReauth}
            loading={busy === "enable" || busy === "disable"}
          >
            {status?.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            variant="secondary-destructive"
            size="sm"
            onClick={() => void disconnect()}
            disabled={disabled || !connected}
            loading={busy === "disconnect"}
          >
            Disconnect
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

function RepoMcpServersSettings({ repo }: { repo: RepoMeta }) {
  const [rows, setRows] = useState<McpServerDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRepoMcpServers(HUB_URL, repo.repoId)
      .then((servers) => {
        if (!cancelled) setRows(servers.map(draftFromServer));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repo.repoId]);

  function updateRow(clientKey: string, patch: Partial<McpServerDraft>) {
    setRows((current) =>
      current.map((row) => (row.clientKey === clientKey ? { ...row, ...patch } : row)),
    );
  }

  function addCloudflareMcpPreset() {
    setRows((current) => {
      const presetByUrl = new Map(CLOUDFLARE_MCP_PRESETS.map((preset) => [preset.url, preset]));
      const claimedPresetUrls = new Set<string>();
      const updatedRows = current.map((row) => {
        const url = canonicalUrlForComparison(row.url);
        const preset = presetByUrl.get(url);
        if (!preset || claimedPresetUrls.has(url)) return row;
        claimedPresetUrls.add(url);
        return { ...row, label: row.label.trim() || preset.label, enabled: true };
      });
      const presentUrls = new Set(updatedRows.map((row) => canonicalUrlForComparison(row.url)));
      return [
        ...updatedRows,
        ...CLOUDFLARE_MCP_PRESETS.filter((preset) => !presentUrls.has(preset.url)).map((preset) => newDraft({
          label: preset.label,
          url: preset.url,
          enabled: true,
        })),
      ];
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const servers = await putRepoMcpServers(HUB_URL, repo.repoId, rows.map(toServerInput));
      setRows(servers.map(draftFromServer));
      addToast({ title: "MCP servers updated", variant: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-kumo-subtle">
          Enabled servers are materialized when sessions start. Existing running sessions are unchanged until restarted.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={addCloudflareMcpPreset}
            disabled={loading || saving}
            title="Adds the Cloudflare Docs MCP server used by this repo."
          >
            Cloudflare Docs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRows((current) => [...current, newDraft()])}
            disabled={loading || saving}
          >
            Add MCP Server
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={loading || saving}
            loading={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-kumo-line bg-kumo-recessed">
        <div className="grid grid-cols-[72px_minmax(120px,220px)_minmax(0,1fr)_72px] gap-3 border-b border-kumo-line px-3 py-2 text-xs font-semibold text-kumo-subtle max-md:grid-cols-1">
          <span>Enabled</span>
          <span>Label</span>
          <span>URL</span>
          <span className="text-right max-md:text-left">Action</span>
        </div>
        {loading ? (
          <div className="px-3 py-4 text-sm text-kumo-subtle">Loading MCP servers...</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-sm text-kumo-subtle">No MCP servers are configured for this repository.</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.clientKey}
              className="grid grid-cols-[72px_minmax(120px,220px)_minmax(0,1fr)_72px] items-center gap-3 border-b border-kumo-line px-3 py-2 last:border-b-0 max-md:grid-cols-1 max-md:items-stretch"
            >
              <Checkbox
                checked={row.enabled}
                disabled={saving}
                onCheckedChange={(checked) => updateRow(row.clientKey, { enabled: checked === true })}
                aria-label="Enabled"
                label={<span className="md:hidden">Enabled</span>}
              />
              <Input
                value={row.label}
                onValueChange={(value) => updateRow(row.clientKey, { label: value })}
                disabled={saving}
                aria-label="MCP server label"
                placeholder="Cloudflare Docs"
                className="min-w-0"
              />
              <Input
                value={row.url}
                onValueChange={(value) => updateRow(row.clientKey, { url: value })}
                disabled={saving}
                aria-label="MCP server URL"
                placeholder="https://example.com/mcp"
                className="min-w-0 font-mono"
              />
              <Button
                variant="secondary-destructive"
                size="sm"
                onClick={() => setRows((current) => current.filter((candidate) => candidate.clientKey !== row.clientKey))}
                disabled={saving}
                className="justify-self-end max-md:justify-self-start"
              >
                Delete
              </Button>
            </div>
          ))
        )}
      </div>

      {error && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

export default function RepoSettingsPage({ repo, onDone }: RepoSettingsPageProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-kumo-recessed">
      <div className="border-b border-kumo-line bg-kumo-base px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-kumo-strong">Repository Settings</h2>
            <p className="mt-1 text-sm text-kumo-subtle">{repoLabel(repo)}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>

      <div className="mx-auto grid max-w-5xl gap-5 px-6 py-6">
        <Section
          title="Session Env"
          description="Manage launch environment variables for this repository."
        >
          <RepoSessionEnvSettings repo={repo} />
        </Section>

        <Section
          title="Cloudflare MCP"
          description="Connect the managed Cloudflare API integration for restarted sessions."
        >
          <RepoCloudflareMcpSettings repo={repo} />
        </Section>

        <Section
          title="MCP Servers"
          description="Manage public no-auth HTTPS MCP servers for restarted sessions."
        >
          <RepoMcpServersSettings repo={repo} />
        </Section>
      </div>
    </div>
  );
}
