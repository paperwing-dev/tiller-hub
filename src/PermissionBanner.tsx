import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { StoredPermission } from "../api/types";
import DiffView from "./DiffView";

interface PermissionBannerProps {
  permission: StoredPermission;
  hubUrl: string;
  sessionId: string;
  onResolved?: (permId: string) => void;
}

type LoadingAction = "allow" | "deny" | "session" | null;

export default function PermissionBanner({ permission, hubUrl, sessionId, onResolved }: PermissionBannerProps) {
  const [loading, setLoading] = useState<LoadingAction>(null);
  const [error, setError] = useState<string | null>(null);

  const toolInput: unknown = tryParse(permission.tool_input);

  async function run(action: Exclude<LoadingAction, null>) {
    setError(null);
    setLoading(action);
    try {
      const res = await fetch(
        `${hubUrl}/api/sessions/${sessionId}/permissions/${permission.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            status: action === "deny" ? "denied" : "allowed",
            allow_for_session: action === "session",
          }),
        },
      );
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      onResolved?.(permission.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  const anyLoading = loading !== null;

  return (
    <div className="border border-kumo-warning/40 bg-kumo-warning-tint px-4 py-3 rounded-lg shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium text-kumo-warning">
          {permission.tool_name}
        </span>
        <span className="text-xs text-kumo-subtle">wants permission</span>
      </div>

      {/* Tool input preview */}
      <div className="mb-3">
        <ToolInputPreview toolName={permission.tool_name} toolInput={toolInput} />
      </div>

      {error && (
        <p className="text-kumo-danger text-xs mb-2">{error}</p>
      )}

      {/* Action buttons */}
      {permission.status === "pending" && (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => run("allow")}
            disabled={anyLoading && loading !== "allow"}
            loading={loading === "allow"}
          >
            {loading === "allow" ? "Allowing..." : "Allow"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => run("session")}
            disabled={anyLoading && loading !== "session"}
            loading={loading === "session"}
          >
            {loading === "session" ? "Allowing..." : "Allow for Session"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => run("deny")}
            disabled={anyLoading && loading !== "deny"}
            loading={loading === "deny"}
          >
            {loading === "deny" ? "Denying..." : "Deny"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Tool input rendering ─────────────────────────────────────────────

function ToolInputPreview({ toolName, toolInput }: { toolName: string; toolInput: unknown }) {
  const input = typeof toolInput === "string" ? tryParse(toolInput) : toolInput;
  if (!input || typeof input !== "object") return null;

  const inp = input as Record<string, unknown>;

  if (toolName === "Bash" && typeof inp.command === "string") {
    return (
      <pre className="bg-kumo-base border border-kumo-line rounded px-3 py-2 text-xs font-mono text-kumo-default overflow-x-auto whitespace-pre-wrap max-h-32">
        <span className="text-kumo-subtle">$ </span>
        {inp.command}
      </pre>
    );
  }

  if (toolName === "Edit") {
    if (typeof inp.old_string === "string" && typeof inp.new_string === "string") {
      return (
        <DiffView
          oldString={inp.old_string}
          newString={inp.new_string}
          filePath={typeof inp.file_path === "string" ? inp.file_path : undefined}
        />
      );
    }
    if (typeof inp.file_path === "string") {
      return <div className="text-xs text-kumo-subtle font-mono">{inp.file_path}</div>;
    }
  }

  if (toolName === "Write") {
    return (
      <div>
        {typeof inp.file_path === "string" && (
          <div className="text-xs text-kumo-subtle font-mono mb-1">{inp.file_path}</div>
        )}
        {typeof inp.content === "string" && (
          <pre className="bg-kumo-base border border-kumo-line rounded px-3 py-2 text-xs font-mono text-kumo-default overflow-x-auto whitespace-pre-wrap max-h-32">
            {inp.content.length > 500 ? inp.content.slice(0, 497) + "..." : inp.content}
          </pre>
        )}
      </div>
    );
  }

  // Fallback: show JSON summary
  return (
    <pre className="bg-kumo-base border border-kumo-line rounded px-3 py-2 text-xs font-mono text-kumo-subtle overflow-x-auto whitespace-pre-wrap max-h-32">
      {JSON.stringify(input, null, 2).slice(0, 500)}
    </pre>
  );
}

function tryParse(json: unknown): unknown {
  if (!json) return null;
  try {
    return typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return null;
  }
}
