import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import type { RepoMeta } from "../api/types";
import type { RepoMcpServer, RepoMcpServerInput } from "./api";
import {
  fetchRepoMcpServers,
  putRepoMcpServers,
} from "./api";
import { useToast } from "./Toast";
import RepoSessionEnvSettings from "./RepoSessionEnvSettings";

const HUB_URL = window.location.origin;
const CLOUDFLARE_DOCS_MCP = {
  label: "Cloudflare Docs",
  url: "https://docs.mcp.cloudflare.com/mcp",
};

// Keep the designed Cloudflare shortcuts available for a future managed MCP
// connection, but do not expose non-functional controls in the live settings UI.
const SHOW_CLOUDFLARE_MCP_UI = false;

interface RepoSettingsPageProps {
  repo: RepoMeta;
  onDone: () => void;
  embedded?: boolean;
  implementationCount?: number;
  onRemoveProject?: () => Promise<void>;
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
    <section className="tiller-settings-section grid gap-5 border-b border-kumo-line px-6 py-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
      <div>
        <h3 className="text-sm font-semibold text-kumo-strong">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-kumo-subtle">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
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

  function addCloudflareDocs() {
    setRows((current) => {
      const existing = current.find(
        (row) => row.url.trim().replace(/\/+$/, "") === CLOUDFLARE_DOCS_MCP.url,
      );
      if (existing) {
        return current.map((row) => row.clientKey === existing.clientKey
          ? { ...row, label: row.label.trim() || CLOUDFLARE_DOCS_MCP.label, enabled: true }
          : row);
      }
      return [...current, newDraft({ ...CLOUDFLARE_DOCS_MCP })];
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
          For now, Tiller supports only public HTTPS MCP servers that don't require authentication.
        </p>
        <div className="flex flex-wrap gap-2">
          {SHOW_CLOUDFLARE_MCP_UI && (
            <Button
              variant="secondary"
              size="sm"
              onClick={addCloudflareDocs}
              disabled={loading || saving}
            >
              Cloudflare Docs
            </Button>
          )}
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
                className="tiller-mcp-enabled-checkbox"
              />
              <Input
                value={row.label}
                onValueChange={(value) => updateRow(row.clientKey, { label: value })}
                disabled={saving}
                aria-label="MCP server label"
                placeholder="Documentation"
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

export default function RepoSettingsPage({
  repo,
  onDone,
  embedded = false,
  implementationCount = 0,
  onRemoveProject,
}: RepoSettingsPageProps) {
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const removeProject = async () => {
    if (!onRemoveProject || removing) return;
    const implementationWarning = implementationCount > 0
      ? `\n\nThis will also delete ${implementationCount} ${implementationCount === 1 ? "implementation" : "implementations"} and their saved workspaces.`
      : "";
    if (!confirm(`Remove project "${repoLabel(repo)}" from Tiller?${implementationWarning}`)) return;

    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemoveProject();
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : "Failed to remove project.");
      setRemoving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-kumo-recessed">
      {!embedded && <div className="border-b border-kumo-line bg-kumo-base px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-kumo-strong">Repository Settings</h2>
            <p className="mt-1 text-sm text-kumo-subtle">{repoLabel(repo)}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>}

      <div className="mx-auto grid max-w-5xl">
        <Section
          title="Task variables"
          description="Manage environment variables injected when this project's coding tasks start."
        >
          <RepoSessionEnvSettings repo={repo} />
        </Section>

        {SHOW_CLOUDFLARE_MCP_UI && (
          <Section
            title="Cloudflare MCP"
            description="Managed Cloudflare account access for new and restarted tasks."
          >
            <div className="tiller-settings-panel grid gap-3 px-3 py-3" aria-disabled="true">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-kumo-default">Cloudflare API</h4>
                    <span className="border border-kumo-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-kumo-subtle">
                      Unavailable
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                    This design requires a managed Cloudflare account connection that the live app does not provide yet.
                  </p>
                </div>
                <Button variant="secondary" size="sm" disabled>
                  Connect
                </Button>
              </div>
            </div>
          </Section>
        )}

        <Section
          title="MCP servers"
          description="Manage public no-auth HTTPS MCP servers for newly started or resumed tasks."
        >
          <RepoMcpServersSettings repo={repo} />
        </Section>

        {onRemoveProject && (
          <Section
            title="Remove project"
            description="Remove this repository and its Tiller workspaces. The GitHub repository is not deleted."
          >
            <div>
              <Button
                type="button"
                variant="secondary-destructive"
                size="sm"
                loading={removing}
                disabled={removing}
                onClick={() => void removeProject()}
              >
                {removing ? "Removing…" : "Remove project"}
              </Button>
              {removeError && <p className="mt-2 text-xs text-kumo-danger">{removeError}</p>}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
