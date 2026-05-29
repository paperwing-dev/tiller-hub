import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useToast } from "./Toast";
import type { HubUpdateRepoCandidate, SetupStatus, VerifyModelAuthResult } from "./api";
import { detectSelfUpdateRepo, fetchSetupStatus, returnToHostedTiller, selectSelfUpdateRepo, submitSetup, verifyModelAuth } from "./api";
import { useGitHubRepositories } from "./useGitHubRepositories";

// Legacy GitHub App controls are commented out inside GitHubAppSettings. If they
// are restored, also restore these imports:
// import type { GitHubAccessTestResult } from "./api";
// import { saveGitHubAppConfig, testGitHubAppAccess } from "./api";
// import { githubRepositoryKey } from "./useGitHubRepositories";

const HUB_URL = window.location.origin;
const CODEX_IMPORT_COMMAND = "tiller auth import codex";

interface SettingsPageProps {
  status: SetupStatus;
  onDone: () => void;
  onRefresh: () => Promise<void>;
}

function Card({
  title,
  description,
  children,
  tone = "default",
}: {
  title: string;
  description: string;
  children: ReactNode;
  tone?: "default" | "success" | "warning";
}) {
  const toneClasses =
    tone === "success"
      ? "border-[#1a7f37]/25 bg-[#f0fff4]"
      : tone === "warning"
        ? "border-[#d4a72c]/30 bg-[#fff8c5]"
        : "border-[#d0d7de] bg-white";

  return (
    <section className={`rounded-2xl border p-5 ${toneClasses}`}>
      <h3 className="text-base font-semibold text-[#24292f]">{title}</h3>
      <p className="mt-1 text-sm text-[#57606a]">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildCodexImportScript(hubUrl: string): string {
  return `bash <<'BASH'
set -euo pipefail

TILLER_HUB_URL=${shellSingleQuote(hubUrl)} node <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const REFRESH_WINDOW_SECONDS = 3600;

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\\/+$/, "");
}

function readJsonFile(filePath, required) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (!required && error && error.code === "ENOENT") return {};
    throw new Error(\`Could not read \${filePath}: \${error.message}\`);
  }
}

function deriveExpiresInSeconds(lastRefresh) {
  if (typeof lastRefresh !== "string" || !lastRefresh.trim()) return undefined;
  const refreshedAt = Date.parse(lastRefresh);
  if (!Number.isFinite(refreshedAt)) return undefined;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - refreshedAt) / 1000));
  return Math.max(0, Math.min(REFRESH_WINDOW_SECONDS, REFRESH_WINDOW_SECONDS - ageSeconds));
}

async function main() {
  if (typeof fetch !== "function") {
    throw new Error("This script requires Node.js 18 or newer.");
  }

  const configPath = process.env.TILLER_CONFIG_PATH || path.join(os.homedir(), ".config", "tiller", "config.json");
  const codexAuthPath = process.env.TILLER_CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");
  const config = readJsonFile(configPath, false);
  const hubUrl = normalizeUrl(process.env.TILLER_HUB_URL || config.hubUrl);
  if (!hubUrl) {
    throw new Error("Missing hub URL.");
  }

  const codexAuth = readJsonFile(codexAuthPath, true);
  if (codexAuth.auth_mode !== "chatgpt") {
    throw new Error("Codex is not logged in with subscription auth. Run codex login first.");
  }

  const accessToken = typeof codexAuth.tokens?.access_token === "string" ? codexAuth.tokens.access_token.trim() : "";
  const refreshToken = typeof codexAuth.tokens?.refresh_token === "string" ? codexAuth.tokens.refresh_token.trim() : "";
  const idToken = typeof codexAuth.tokens?.id_token === "string" ? codexAuth.tokens.id_token.trim() : "";
  if (!accessToken || !refreshToken) {
    throw new Error(\`Missing Codex subscription tokens in \${codexAuthPath}.\`);
  }

  const headers = { "Content-Type": "application/json" };
  const clientId = String(process.env.CF_ACCESS_CLIENT_ID || config.clientId || "").trim();
  const clientSecret = String(process.env.CF_ACCESS_CLIENT_SECRET || config.clientSecret || "").trim();
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new Error("Cloudflare Access credentials are incomplete. If Tiller is installed, run tiller once to refresh the saved hub config.");
  }
  if (clientId && clientSecret) {
    headers["CF-Access-Client-Id"] = clientId;
    headers["CF-Access-Client-Secret"] = clientSecret;
  }

  const expiresIn = deriveExpiresInSeconds(codexAuth.last_refresh);
  const body = {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(idToken ? { id_token: idToken } : {}),
    ...(expiresIn != null ? { expires_in: expiresIn } : {}),
  };

  const response = await fetch(\`\${hubUrl}/api/auth/openai/seed\`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : text.slice(0, 300) || \`HTTP \${response.status}\`;
    if (response.status === 401 || response.status === 403 || /Cloudflare Access|<html/i.test(detail)) {
      throw new Error(\`\${detail}\\nHub access failed. If Tiller is installed, run tiller auth import codex instead.\`);
    }
    throw new Error(detail);
  }

  const account = typeof payload.account_id === "string" && payload.account_id ? \` for \${payload.account_id}\` : "";
  console.log(\`Imported Codex subscription login\${account}.\`);
}

main().catch((error) => {
  console.error(\`[tiller] \${error.message}\`);
  process.exit(1);
});
NODE
BASH`;
}

function codexSubscriptionStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (status.chatgptAuthStatus === "needs_reconnect") {
    return {
      title: "Subscription needs re-import",
      detail: "Tiller can no longer refresh the imported Codex subscription.",
      tone: "warning",
    };
  }

  if (status.openaiPlannerAvailable && status.openaiPlannerRoute === "api-key") {
    return {
      title: "API key fallback active",
      detail: "The OpenAI planner is using the configured API key.",
      tone: "success",
    };
  }

  if (status.openaiPlannerAvailable && status.openaiPlannerRoute === "subscription-gateway") {
    return {
      title: "Subscription active",
      detail: "The OpenAI planner is using the imported Codex subscription through the Subscription Gateway.",
      tone: "success",
    };
  }

  if (status.hasChatGPTAuth || status.chatgptAuthStatus === "refreshing") {
    if (!status.hostRegistered) {
      return {
        title: "Subscription imported",
        detail: "The subscription route stays inactive until a Tiller Self Host registers and publishes its Subscription Gateway.",
        tone: "warning",
      };
    }

    if (!status.hostConnected) {
      return {
        title: "Subscription imported",
        detail: "The subscription route stays inactive until the registered Tiller Self Host reconnects.",
        tone: "warning",
      };
    }

    if (!status.hostGatewayConfigured) {
      return {
        title: "Subscription imported",
        detail: "The subscription route stays inactive until the Subscription Gateway is configured and published.",
        tone: "warning",
      };
    }

    if (!status.hostGatewayAvailable) {
      return {
        title: "Subscription imported",
        detail: "The subscription route stays inactive until the published Subscription Gateway becomes reachable.",
        tone: "warning",
      };
    }

    return {
      title: "Subscription imported",
      detail: status.openaiPlannerReason || "The subscription route stays inactive until the published Subscription Gateway is healthy.",
      tone: "warning",
    };
  }

  if (status.hasOpenAIKey) {
    return {
      title: "API key fallback configured",
      detail: "Hosted Tiller Codex environments use the configured API key.",
      tone: "warning",
    };
  }

  return {
    title: "Subscription not imported",
    detail: "Import an existing Codex subscription to enable the Self Host OpenAI planner through the Subscription Gateway.",
    tone: "neutral",
  };
}

function statusToneClasses(tone: "success" | "warning" | "neutral") {
  if (tone === "success") {
    return {
      title: "text-[#1a7f37]",
      dot: "bg-[#1a7f37]",
    };
  }

  if (tone === "warning") {
    return {
      title: "text-[#9a6700]",
      dot: "bg-[#d4a72c]",
    };
  }

  return {
    title: "text-[#24292f]",
    dot: "bg-[#d0d7de]",
  };
}

function visibleGitHubOwnersForUpdateRepo(status: SetupStatus["selfUpdateRepo"]): string[] {
  return status.status === "missing" ? status.visibleGitHubOwners : [];
}

function formatVisibleGitHubOwners(owners: string[]): string {
  if (owners.length === 0) return "no GitHub owners";
  if (owners.length === 1) return owners[0];
  return owners.join(", ");
}

function hostRuntimeStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (!status.hostRegistered) {
    return {
      title: "Not registered",
      detail: status.isLocalDev
        ? "Run `tiller host` to register a host machine with this hub."
        : "Connect a Tiller Self Host machine to this hub to make self-host environments available.",
      tone: "neutral",
    };
  }

  if (!status.hostConnected) {
    return {
      title: "Registered, offline",
      detail: "The hub still has a registered host record, but the live host session is offline.",
      tone: "warning",
    };
  }

  return {
    title: "Connected",
    detail: "The hub currently has a live route to the registered Tiller Self Host.",
    tone: "success",
  };
}

function hostGatewayStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (!status.hostGatewayConfigured) {
    return {
      title: "Not configured",
      detail: "The Tiller Self Host is not publishing a Subscription Gateway yet.",
      tone: status.hostConnected ? "warning" : "neutral",
    };
  }

  if (!status.hostGatewayAvailable) {
    return {
      title: "Configured, unavailable",
      detail: "A Subscription Gateway URL is configured, but it is not currently available through the live self-host connection.",
      tone: "warning",
    };
  }

  return {
    title: "Available",
    detail: status.hostGatewayMode === "named"
      ? "The Subscription Gateway is available through a named tunnel."
      : status.hostGatewayMode === "quick"
        ? "The Subscription Gateway is available through a quick tunnel."
        : "The Subscription Gateway is available.",
    tone: "success",
  };
}

// ── Credential row ───────────────────────────────────────────────

interface CredentialDef {
  label: string;
  description?: string;
  secretKey: string;
  configured: boolean;
  testable: boolean;
  partial?: boolean;
  help?: ReactNode;
}

function getCredentialStatusChip(state: "configured" | "partial" | "missing") {
  if (state === "configured") {
    return {
      label: "Configured",
      dotClassName: "bg-[#1a7f37]",
      textClassName: "text-[#1a7f37]",
    };
  }

  if (state === "partial") {
    return {
      label: "Incomplete",
      dotClassName: "bg-[#d4a72c]",
      textClassName: "text-[#9a6700]",
    };
  }

  return {
    label: "Not configured",
    dotClassName: "bg-[#d0d7de]",
    textClassName: "text-[#57606a]",
  };
}

function getCredentialTestResultText(testResult: VerifyModelAuthResult | null, fallbackOkText: string): {
  text: string;
  className: string;
} | null {
  if (!testResult) {
    return null;
  }

  if (!testResult.ok) {
    return {
      text: `— ${testResult.error || "Invalid"}`,
      className: "text-[#cf222e]",
    };
  }

  if (testResult.warning) {
    return {
      text: `— ${testResult.warning}`,
      className: "text-[#9a6700]",
    };
  }

  return {
    text: testResult.note ? `— ${testResult.note}` : fallbackOkText,
    className: "text-[#1a7f37]",
  };
}

function CredentialRowFrame({
  label,
  description,
  status,
  testResult,
  okText,
  canTest,
  editing,
  testing,
  onStartEdit,
  onTest,
  actionLabel,
  error,
  children,
}: {
  label: string;
  description?: string;
  status: "configured" | "partial" | "missing";
  testResult: VerifyModelAuthResult | null;
  okText: string;
  canTest: boolean;
  editing: boolean;
  testing: boolean;
  onStartEdit: () => void;
  onTest: () => Promise<void>;
  actionLabel: string;
  error: string | null;
  children?: ReactNode;
}) {
  const statusChip = getCredentialStatusChip(status);
  const testResultText = getCredentialTestResultText(testResult, okText);

  return (
    <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#24292f]">{label}</p>
          {description && <p className="mt-0.5 text-xs text-[#57606a]">{description}</p>}
          <div className="mt-2 flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 text-xs ${statusChip.textClassName}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${statusChip.dotClassName}`} />
              {statusChip.label}
            </span>

            {testResultText && (
              <span className={`text-xs ${testResultText.className}`}>
                {testResultText.text}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          {canTest && !editing && (
            <button
              type="button"
              onClick={() => void onTest()}
              disabled={testing}
              className="rounded border border-[#d0d7de] bg-white px-2.5 py-1 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-40"
            >
              {testing ? "Testing..." : "Test"}
            </button>
          )}
          {!editing && (
            <button
              type="button"
              onClick={onStartEdit}
              className="rounded border border-[#d0d7de] bg-white px-2.5 py-1 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>

      {children}

      {error && <p className="mt-2 text-xs text-[#cf222e]">{error}</p>}
    </div>
  );
}

function CredentialRow({
  def,
  testResult,
  onSave,
  onTest,
}: {
  def: CredentialDef;
  testResult: VerifyModelAuthResult | null;
  onSave: (payload: Record<string, string>) => Promise<void>;
  onTest: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ [def.secretKey]: value.trim() });
      setValue("");
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    try {
      await onTest();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <CredentialRowFrame
      label={def.label}
      description={def.description}
      status={def.configured ? "configured" : def.partial ? "partial" : "missing"}
      testResult={testResult}
      okText="— Key is valid"
      canTest={def.configured && def.testable}
      editing={editing}
      testing={testing}
      onStartEdit={() => {
        setEditing(true);
        setError(null);
      }}
      onTest={handleTest}
      actionLabel={def.configured || def.partial ? "Replace" : "Add"}
      error={error}
    >
      {def.help}
      {editing && (
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${def.label.toLowerCase()}`}
            autoFocus
            disabled={saving}
            className="flex-1 rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !value.trim()}
            className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setValue("");
              setError(null);
            }}
            disabled={saving}
            className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#57606a] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </CredentialRowFrame>
  );
}

function ClaudeSubscriptionSetupHint() {
  return (
    <div className="mt-3 rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
      <ol className="list-decimal space-y-1 pl-4 text-xs text-[#57606a]">
        <li>
          On a trusted machine where you can log in to Claude Code, run{" "}
          <code>claude setup-token</code>.
        </li>
        <li>
          Complete the browser login with your Claude Pro, Max, Team, or Enterprise account, then paste the printed
          token here.
        </li>
      </ol>
    </div>
  );
}

function CodexSubscriptionRow({
  status,
  codexStatus,
  onImport,
  importDisabled,
  onCheckStatus,
  checkingStatus,
}: {
  status: SetupStatus;
  codexStatus: ReturnType<typeof codexSubscriptionStatus>;
  onImport: () => void;
  importDisabled: boolean;
  onCheckStatus: () => void;
  checkingStatus: boolean;
}) {
  return (
    <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] px-4 py-3">
      <p className="text-sm font-semibold text-[#24292f]">Codex Subscription Login</p>
      <p
        className={`mt-2 text-sm font-medium ${
          codexStatus.tone === "success"
            ? "text-[#1a7f37]"
            : codexStatus.tone === "warning"
              ? "text-[#9a6700]"
              : "text-[#24292f]"
        }`}
      >
        {codexStatus.title}
      </p>
      <p className="mt-1 text-xs text-[#57606a]">{codexStatus.detail}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCheckStatus}
          disabled={checkingStatus}
          className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
        >
          {checkingStatus ? "Checking..." : "Check status"}
        </button>
        <button
          type="button"
          className="rounded border border-[#0969da] bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0860ca] disabled:cursor-not-allowed disabled:border-[#d0d7de] disabled:bg-[#f6f8fa] disabled:text-[#8c959f]"
          onClick={onImport}
          disabled={importDisabled}
          title={importDisabled ? "Codex login is already imported. Check status to refresh the connection state." : undefined}
        >
          Import Codex Login
        </button>
      </div>
      <p className="mt-2 text-xs text-[#57606a]">
        {importDisabled
          ? "Codex login is already imported. Use Check status to refresh the connection state."
          : "Run the import from the computer where Codex is already logged in."}
      </p>
      {!status.hostConnected && (
        <p className="mt-2 text-xs text-[#9a6700]">
          Keep <code>tiller host</code> running when you want Tiller Self Host Codex environments or the OpenAI planner
          to use this subscription route.
        </p>
      )}
    </div>
  );
}

function CodexImportDialog({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<"script" | "command" | null>(null);
  const script = buildCodexImportScript(HUB_URL);

  async function copy(value: string, kind: "script" | "command") {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1800);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#24292f]/40 px-4 py-6">
      <div className="flex max-h-full w-full max-w-3xl flex-col rounded-xl border border-[#d0d7de] bg-[#f6f8fa] shadow-xl">
        <div className="border-b border-[#d0d7de] px-5 py-4">
          <h3 className="text-base font-semibold text-[#24292f]">Import Codex Login</h3>
          <p className="mt-1 text-sm text-[#57606a]">
            Run this on the computer where Codex already works with your subscription.
          </p>
        </div>

        <div className="grid gap-3 overflow-y-auto px-5 py-4">
          <p className="text-sm text-[#57606a]">
            Copy the import script and paste it into Terminal. It reads the local Codex login automatically, so rerun
            {" "}<code>codex login</code> first if Codex is not already logged in on that machine.
          </p>
          <button
            type="button"
            onClick={() => void copy(script, "script")}
            className="w-fit rounded border border-[#0969da] bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0860ca]"
          >
            {copied === "script" ? "Copied" : "Copy import script"}
          </button>
          <p className="text-xs text-[#57606a]">
            If Tiller is installed on that computer, you can use <code>{CODEX_IMPORT_COMMAND}</code> instead.
          </p>
          <button
            type="button"
            onClick={() => void copy(CODEX_IMPORT_COMMAND, "command")}
            className="w-fit rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
          >
            {copied === "command" ? "Copied" : "Copy Tiller command"}
          </button>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#d0d7de] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#0969da] bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0860ca]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function OpenCodeInfoRow() {
  return (
    <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#24292f]">OpenCode on Workers AI</p>
          <p className="mt-0.5 text-xs text-[#57606a]">
            OpenCode uses Tiller&apos;s built-in Workers AI binding through the hub proxy. No extra Cloudflare
            credentials are required.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-[#1a7f37]">
              <span className="inline-block h-2 w-2 rounded-full bg-[#1a7f37]" />
              Built in
            </span>
            <span className="text-xs text-[#57606a]">Pinned to Kimi K2.5</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Idle timeout row ────────────────────────────────────────────

function IdleTimeoutRow({
  currentMinutes,
  onSave,
}: {
  currentMinutes: number;
  onSave: (minutes: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(currentMinutes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1440) {
      setError("Enter a value between 1 and 1440 minutes.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#24292f]">Idle timeout</p>
          <p className="mt-0.5 text-xs text-[#57606a]">
            Minutes of inactivity before containers are stopped. Default: 10.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-[#24292f]">
              <span className="inline-block h-2 w-2 rounded-full bg-[#1a7f37]" />
              {currentMinutes} {currentMinutes === 1 ? "minute" : "minutes"}
            </span>
          </div>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setValue(String(currentMinutes));
              setEditing(true);
              setError(null);
            }}
            className="rounded border border-[#d0d7de] bg-white px-2.5 py-1 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
          >
            Change
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex gap-2">
          <input
            type="number"
            min={1}
            max={1440}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            disabled={saving}
            className="w-24 rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
          />
          <span className="self-center text-xs text-[#57606a]">minutes</span>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
            className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#57606a] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-[#cf222e]">{error}</p>}
    </div>
  );
}

function CanonicalMainBootstrapDepthRow({
  currentDepth,
  onSave,
}: {
  currentDepth: number;
  onSave: (depth: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(currentDepth));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
      setError("Enter 0 for full history, or a value between 1 and 200 commits.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#24292f]">Canonical main history depth</p>
          <p className="mt-0.5 text-xs text-[#57606a]">
            Full history gives repo-level merge and update jobs complete context. Set a positive value to shallow-clone for faster initial setup.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-[#24292f]">
              <span className="inline-block h-2 w-2 rounded-full bg-[#1a7f37]" />
              {currentDepth === 0
                ? "Full history"
                : `${currentDepth} ${currentDepth === 1 ? "commit" : "commits"}`}
            </span>
          </div>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setValue(String(currentDepth));
              setEditing(true);
              setError(null);
            }}
            className="rounded border border-[#d0d7de] bg-white px-2.5 py-1 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
          >
            Change
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex gap-2">
          <input
            type="number"
            min={0}
            max={200}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            disabled={saving}
            className="w-24 rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
          />
          <span className="self-center text-xs text-[#57606a]">commits</span>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
            className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#57606a] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-[#cf222e]">{error}</p>}
    </div>
  );
}

function GitHubAppSettings({
  status,
  onRefresh,
}: {
  status: SetupStatus;
  onRefresh: () => Promise<void>;
}) {
  const [waitingForCreation, setWaitingForCreation] = useState(false);
  const [detectingUpdateRepo, setDetectingUpdateRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToast();
  const createUrl = `${HUB_URL}/api/github/manifest/setup`;
  const configured = status.githubAppConfigured;
  const installUrl = status.githubAppInstallUrl ?? null;
  const githubRepositories = useGitHubRepositories(HUB_URL, {
    enabled: configured && !status.githubAppPublicHubDisabled,
  });
  const repoSelections = githubRepositories.repositories;
  const loadingRepos = githubRepositories.loading;
  const selfUpdateRepo = status.selfUpdateRepo ?? { status: "not_checked" as const, lastDetectedAt: null };
  const showSelfUpdateRepo = status.buildDiagnostics.channel === "release";
  const repositorySelection = githubRepositories.repositorySelection;
  const allRepositoriesAvailable = configured && repositorySelection === "all" && repoSelections.length > 0;
  const visibleUpdateRepoOwners = visibleGitHubOwnersForUpdateRepo(selfUpdateRepo);
  const githubAppUrl = status.githubAppSlug ? `https://github.com/apps/${encodeURIComponent(status.githubAppSlug)}` : null;

  /*
   * Legacy GitHub App controls, commented out for possible reintroduction.
   *
   * const [manualOpen, setManualOpen] = useState(false);
   * const [selectedRepoKey, setSelectedRepoKey] = useState("");
   * const [testing, setTesting] = useState(false);
   * const [lastTest, setLastTest] = useState<GitHubAccessTestResult | null>(null);
   * const [appId, setAppId] = useState("");
   * const [clientId, setClientId] = useState("");
   * const [slug, setSlug] = useState("");
   * const [privateKey, setPrivateKey] = useState("");
   * const [saving, setSaving] = useState(false);
   * const manifestCallbackUrl = `${HUB_URL}/api/github/manifest/callback`;
   * const installCallbackUrl = `${HUB_URL}/api/github/install/callback`;
   * const installUrl = status.githubAppInstallUrl ?? lastTest?.installUrl ?? null;
   * const manageUrl = status.githubAppManageUrl ?? lastTest?.manageUrl ?? "https://github.com/settings/installations";
   * const selectedRepo = repoSelections.find((selection) => githubRepositoryKey(selection) === selectedRepoKey) ?? null;
   *
   * useEffect(() => {
   *   setSelectedRepoKey(repoSelections[0] ? githubRepositoryKey(repoSelections[0]) : "");
   * }, [repoSelections]);
   *
   * useEffect(() => {
   *   if (!githubRepositories.error) return;
   *   setLastTest({
   *     ok: false,
   *     status: "github_error",
   *     message: githubRepositories.error,
   *     repo: null,
   *     installUrl,
   *     manageUrl,
   *   });
   * }, [githubRepositories.error, installUrl, manageUrl]);
   *
   * async function handleSave() {
   *   if (!appId.trim() || !clientId.trim() || !slug.trim() || !privateKey.trim()) {
   *     setError("App ID, client ID, slug, and private key are required.");
   *     return;
   *   }
   *   setSaving(true);
   *   setError(null);
   *   try {
   *     await saveGitHubAppConfig(HUB_URL, {
   *       appId: appId.trim(),
   *       clientId: clientId.trim(),
   *       slug: slug.trim(),
   *       privateKey: privateKey.trim(),
   *     });
   *     setAppId("");
   *     setClientId("");
   *     setSlug("");
   *     setPrivateKey("");
   *     setManualOpen(false);
   *     await onRefresh();
   *     addToast({ title: "GitHub App saved", variant: "success" });
   *   } catch (err) {
   *     setError(err instanceof Error ? err.message : String(err));
   *   } finally {
   *     setSaving(false);
   *   }
   * }
   *
   * async function handleTestAccess() {
   *   if (!selectedRepo) {
   *     setLastTest({
   *       ok: false,
   *       status: "invalid_repo",
   *       message: "Select a repository from the GitHub App repository list.",
   *       repo: null,
   *       installUrl,
   *       manageUrl,
   *     });
   *     return;
   *   }
   *
   *   setTesting(true);
   *   setError(null);
   *   try {
   *     const result = await testGitHubAppAccess(HUB_URL, selectedRepo);
   *     setLastTest(result);
   *     if (result.ok) {
   *       if (showSelfUpdateRepo) {
   *         await detectSelfUpdateRepo(HUB_URL).catch(() => null);
   *       }
   *       await onRefresh();
   *       addToast({ title: "GitHub repo access ready", variant: "success" });
   *     }
   *   } catch (err) {
   *     setLastTest({
   *       ok: false,
   *       status: "github_error",
   *       message: err instanceof Error ? err.message : String(err),
   *       repo: selectedRepo.fullName,
   *       installUrl,
   *       manageUrl,
   *     });
   *   } finally {
   *     setTesting(false);
   *   }
   * }
   *
   * function accessResultCopy(result: GitHubAccessTestResult): { title: string; detail: string; tone: "success" | "warning" | "error" } {
   *   switch (result.status) {
   *     case "ready":
   *       return {
   *         title: "Repository access ready",
   *         detail: result.repo ? `Tiller can use the GitHub App with ${result.repo}.` : result.message,
   *         tone: "success",
   *       };
   *     case "missing_permissions":
   *       return {
   *         title: "Permissions need updating",
   *         detail: "This app was created with read-only permissions. Create a replacement app with pull request permissions, then install it on this repository.",
   *         tone: "warning",
   *       };
   *     case "missing_installation":
   *       return {
   *         title: "App not installed for this owner",
   *         detail: "Install the GitHub App on the owner account, then select the repository Tiller should use.",
   *         tone: "warning",
   *       };
   *     case "repo_not_selected":
   *       return {
   *         title: "Repository not selected",
   *         detail: "Edit the GitHub App installation and select this repository.",
   *         tone: "warning",
   *       };
   *     case "not_configured":
   *       return {
   *         title: "GitHub App not created",
   *         detail: "Create the GitHub App first, then install it on repositories.",
   *         tone: "warning",
   *       };
   *     case "invalid_repo":
   *       return {
   *         title: "Repository format needs fixing",
   *         detail: result.message,
   *         tone: "error",
   *       };
   *     case "invalid_config":
   *       return {
   *         title: "GitHub App config is invalid",
   *         detail: "Replace the app config from Advanced, or create a fresh app with the guided flow.",
   *         tone: "error",
   *       };
   *     case "public_hub_disabled":
   *       return {
   *         title: "Private repo access is unavailable",
   *         detail: "Publish and protect this hub, or use a localhost hub.",
   *         tone: "warning",
   *       };
   *     case "github_error":
   *     default:
   *       return {
   *         title: "GitHub access check failed",
   *         detail: result.message,
   *         tone: "error",
   *       };
   *   }
   * }
   *
   * const testCopy = lastTest ? accessResultCopy(lastTest) : null;
   * const resultClasses = testCopy?.tone === "success"
   *   ? "border-[#1a7f37]/25 bg-[#f0fff4] text-[#1a7f37]"
   *   : testCopy?.tone === "warning"
   *     ? "border-[#d4a72c]/30 bg-[#fff8c5] text-[#9a6700]"
   *     : "border-[#cf222e]/25 bg-[#fff1f1] text-[#cf222e]";
   */

  useEffect(() => {
    if (!waitingForCreation || configured) {
      if (configured && waitingForCreation) setWaitingForCreation(false);
      return undefined;
    }

    const timer = window.setInterval(() => {
      void onRefresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [configured, onRefresh, waitingForCreation]);

  useEffect(() => {
    function handleFocus() {
      void onRefresh();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [onRefresh]);

  async function handleDetectSelfUpdateRepo() {
    setDetectingUpdateRepo(true);
    setError(null);
    try {
      const result = await detectSelfUpdateRepo(HUB_URL);
      await onRefresh();
      addToast({
        title: result.status === "detected"
          ? "Self-update repo connected"
          : result.status === "ambiguous"
            ? "Choose self-update repo"
            : "Self-update repo not found",
        body: result.status === "detected"
          ? result.fullName
          : result.status === "ambiguous"
            ? "Multiple selected repositories contain Tiller update metadata."
            : "No selected GitHub App repository contains Tiller deploy-button metadata.",
        variant: result.status === "detected" ? "success" : "warning",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetectingUpdateRepo(false);
    }
  }

  async function handleSelectSelfUpdateRepo(candidate: HubUpdateRepoCandidate) {
    setDetectingUpdateRepo(true);
    setError(null);
    try {
      const result = await selectSelfUpdateRepo(HUB_URL, candidate);
      await onRefresh();
      addToast({
        title: "Self-update repo connected",
        body: result.status === "detected" ? result.fullName : candidate.fullName,
        variant: "success",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetectingUpdateRepo(false);
    }
  }

  const selfUpdateRepoPanel = configured && showSelfUpdateRepo && selfUpdateRepo.status !== "not_checked" ? (
    <div className="rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[#24292f]">Self-update repo</p>
          <p className="mt-1 text-xs text-[#57606a]">
            {selfUpdateRepo.status === "detected"
              ? `${selfUpdateRepo.fullName} · ${selfUpdateRepo.branch}`
              : selfUpdateRepo.status === "ambiguous"
                ? "Multiple selected repositories look like Tiller hubs."
                : "Auto-detected when a selected GitHub App repository contains Tiller deploy-button metadata."}
          </p>
        </div>
        {selfUpdateRepo.status !== "detected" && (
          <button
            type="button"
            onClick={() => void handleDetectSelfUpdateRepo()}
            disabled={detectingUpdateRepo}
            className="rounded border border-[#0969da] bg-white px-2.5 py-1 text-xs font-medium text-[#0969da] transition-colors hover:bg-[#ddf4ff] disabled:opacity-50"
          >
            {detectingUpdateRepo ? "Checking..." : "Connect self-update repo"}
          </button>
        )}
      </div>
      {selfUpdateRepo.status === "ambiguous" && (
        <div className="mt-3 grid gap-2">
          {selfUpdateRepo.candidates.map((candidate) => (
            <button
              key={`${candidate.repoId}:${candidate.branch}`}
              type="button"
              onClick={() => void handleSelectSelfUpdateRepo(candidate)}
              disabled={detectingUpdateRepo}
              className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-left text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}
      {selfUpdateRepo.status === "missing" && (
        <div className="mt-3 rounded-lg border border-[#d4a72c]/30 bg-[#fff8c5] px-3 py-2">
          <p className="text-xs font-semibold text-[#9a6700]">Check the GitHub account</p>
          <p className="mt-1 text-xs leading-5 text-[#57606a]">
            Cloudflare must deploy this Worker from a repo under the same GitHub user or org selected for the Tiller GitHub App.
            {visibleUpdateRepoOwners.length > 0
              ? ` Tiller can currently see ${formatVisibleGitHubOwners(visibleUpdateRepoOwners)}.`
              : " Tiller cannot currently see any selected GitHub App repositories."}
            {" "}Open Cloudflare Worker Settings &gt; Builds and compare the connected repo owner.
          </p>
        </div>
      )}
    </div>
  ) : null;

  if (status.githubAppPublicHubDisabled) {
    return (
      <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
        <p className="text-sm font-semibold text-[#24292f]">Private repo access</p>
        <p className="mt-1 text-xs text-[#57606a]">
          GitHub App private repo access is available after Protect Hub or Self Host setup, or on a localhost hub.
        </p>
      </div>
    );
  }

  if (configured && status.githubAppReady) {
    return (
      <div className="grid gap-3">
        <div className="grid gap-2">
          <p className="text-sm font-semibold text-[#1a7f37]">GitHub App configured</p>
          <p className="text-xs leading-5 text-[#57606a]">
            Tiller can use the repositories selected in this GitHub App installation for private repository access and pull request permissions.
          </p>
          {githubAppUrl ? (
            <div className="mt-1 border-t border-[#d0d7de] pt-3">
              <p className="text-xs font-semibold text-[#24292f]">GitHub App URL</p>
              <a
                href={githubAppUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block break-all text-xs font-medium text-[#0969da] hover:underline"
              >
                {githubAppUrl}
              </a>
              <p className="mt-1 text-xs leading-5 text-[#57606a]">
                This is the GitHub App Tiller created for this hub. It is not a repository URL; GitHub uses it to manage which repositories Tiller can access.
              </p>
            </div>
          ) : null}
        </div>
        {selfUpdateRepoPanel}
        {error && <p className="text-xs text-[#cf222e]">{error}</p>}
      </div>
    );
  }

  const stepBoxClasses = {
    success: "border-[#1a7f37]/25 bg-[#f0fff4]",
    warning: "border-[#d4a72c]/30 bg-[#fff8c5]",
    error: "border-[#cf222e]/25 bg-[#fff1f1]",
    neutral: "border-[#d0d7de] bg-[#f6f8fa]",
  };
  const repositoryAccessReady = configured && !loadingRepos && !githubRepositories.error && repoSelections.length > 0;
  const repositoryStep = !configured
    ? {
        label: "Waiting for app",
        detail: "Create the GitHub App before choosing repository access.",
        tone: "neutral" as const,
      }
    : loadingRepos
      ? {
          label: "Checking repositories",
          detail: "Loading GitHub App repository access.",
          tone: "neutral" as const,
        }
      : githubRepositories.error
        ? {
            label: "Repository access needs attention",
            detail: githubRepositories.error,
            tone: "error" as const,
          }
        : repoSelections.length === 0
          ? {
              label: "No repositories available",
              detail: githubRepositories.warnings[0]?.message ?? "No repositories are selected in the configured GitHub App installation.",
              tone: "warning" as const,
            }
          : allRepositoriesAvailable
            ? {
                label: "All repositories available",
                detail: status.githubAppSlug ? `${status.githubAppSlug} is installed for all repositories.` : "The GitHub App is installed for all repositories.",
                tone: "success" as const,
              }
            : {
                label: `${repoSelections.length} selected ${repoSelections.length === 1 ? "repository" : "repositories"} available`,
                detail: "The GitHub App can use the repositories selected during installation.",
                tone: "success" as const,
              };
  const readyStep = repositoryAccessReady
    ? {
        label: "Ready for private repos",
        detail: "Tiller will use this GitHub App automatically for private repository access and pull request permissions.",
        tone: "success" as const,
      }
    : configured
      ? {
          label: "Waiting for repository access",
          detail: "This completes automatically once GitHub reports at least one available repository.",
          tone: githubRepositories.error || repoSelections.length === 0 ? "warning" as const : "neutral" as const,
        }
      : {
          label: "Waiting for setup",
          detail: "This completes after the app is created and repositories are available.",
          tone: "neutral" as const,
        };
  const createStepTone = configured ? "success" : waitingForCreation ? "warning" : "neutral";

  return (
    <div className="grid gap-3 rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#24292f]">
            {configured ? "GitHub App configured" : "GitHub App not set up"}
          </p>
          {configured && status.githubAppSlug && (
            <p className="mt-1 text-xs text-[#57606a]">{status.githubAppSlug}</p>
          )}
        </div>
        {/*
        <div className="flex flex-wrap justify-end gap-2">
          {configured && (
            <a
              href={manageUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-[#d0d7de] bg-white px-2.5 py-1 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              Manage GitHub Apps
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              setManualOpen((value) => !value);
              setError(null);
            }}
            className="rounded border border-[#d0d7de] bg-white px-2.5 py-1 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
          >
            {manualOpen ? "Close advanced" : "Advanced"}
          </button>
        </div>
        */}
      </div>

      <div className="grid gap-2">
        <div className={`rounded-lg border px-3 py-2 ${stepBoxClasses[createStepTone]}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[#24292f]">1. Create GitHub App</p>
              <p className="mt-1 text-xs leading-5 text-[#57606a]">
                {configured
                  ? status.githubAppSlug
                    ? `Created: ${status.githubAppSlug}`
                    : "Created"
                  : waitingForCreation
                    ? "Waiting for GitHub to return app config."
                    : "Create the app owned by this GitHub account."}
              </p>
            </div>
            {!configured && (
              <a
                href={createUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  setWaitingForCreation(true);
                }}
                className="rounded border border-[#0969da] bg-[#0969da] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[#0860ca]"
              >
                Create GitHub App
              </a>
            )}
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 ${stepBoxClasses[repositoryStep.tone]}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[#24292f]">2. Install repositories</p>
              <p className="mt-1 text-xs leading-5 text-[#57606a]">{repositoryStep.label}: {repositoryStep.detail}</p>
            </div>
            {configured && installUrl && !allRepositoriesAvailable && (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-[#0969da] bg-[#0969da] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[#0860ca]"
              >
                {repoSelections.length > 0 ? "Install more repos" : "Install repositories"}
              </a>
            )}
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 ${stepBoxClasses[readyStep.tone]}`}>
          <p className="text-xs font-semibold text-[#24292f]">3. Use in Tiller</p>
          <p className="mt-1 text-xs leading-5 text-[#57606a]">{readyStep.label}: {readyStep.detail}</p>
        </div>
      </div>

      {/*
      <div className="grid gap-2 md:grid-cols-3">
        <div className={`rounded-lg border px-3 py-2 ${configured ? "border-[#1a7f37]/25 bg-[#f0fff4]" : "border-[#d0d7de] bg-[#f6f8fa]"}`}>
          <p className="text-xs font-semibold text-[#24292f]">1. Create app</p>
          <p className="mt-1 text-xs text-[#57606a]">
            {configured
              ? `Created${status.githubAppSlug ? `: ${status.githubAppSlug}` : ""}`
              : waitingForCreation
                ? "Waiting for GitHub to return app config."
                : "Opens GitHub in a new tab."}
          </p>
        </div>
        <div className={`rounded-lg border px-3 py-2 ${configured ? "border-[#d4a72c]/30 bg-[#fff8c5]" : "border-[#d0d7de] bg-[#f6f8fa]"}`}>
          <p className="text-xs font-semibold text-[#24292f]">2. Install on repos</p>
          <p className="mt-1 text-xs text-[#57606a]">
            {configured ? "Select the repositories Tiller can use." : "Available after app creation."}
          </p>
        </div>
        <div className={`rounded-lg border px-3 py-2 ${lastTest?.ok ? "border-[#1a7f37]/25 bg-[#f0fff4]" : "border-[#d0d7de] bg-[#f6f8fa]"}`}>
          <p className="text-xs font-semibold text-[#24292f]">3. Test access</p>
          <p className="mt-1 text-xs text-[#57606a]">
            {lastTest?.ok ? `Ready for ${lastTest.repo}` : "Verify selected repo access and PR permissions."}
          </p>
        </div>
      </div>
      */}

      {waitingForCreation && !configured && (
        <div className="rounded-lg border border-[#d4a72c]/30 bg-[#fff8c5] px-3 py-2">
          <p className="text-xs font-semibold text-[#9a6700]">Keep this tab open</p>
          <p className="mt-1 text-xs text-[#57606a]">
            GitHub is open in another tab. Tiller will refresh this page state when the app is created.
          </p>
        </div>
      )}

      {/*
      {configured && (
        <div className="grid gap-2 rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-[220px] flex-1 gap-1">
              <span className="text-xs font-medium text-[#24292f]">Repository</span>
              <select
                value={selectedRepoKey}
                onChange={(event) => {
                  setSelectedRepoKey(event.target.value);
                  setLastTest(null);
                }}
                disabled={testing || loadingRepos}
                className="rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
              >
                <option value="">
                  {loadingRepos ? "Loading repositories..." : repoSelections.length === 0 ? "No selected repositories" : "Select repository"}
                </option>
                {repoSelections.map((selection) => (
                  <option key={githubRepositoryKey(selection)} value={githubRepositoryKey(selection)}>
                    {selection.fullName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void handleTestAccess()}
              disabled={testing || loadingRepos || !selectedRepo}
              className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
            >
              {testing ? "Testing..." : "Test access"}
            </button>
          </div>
          {testCopy && (
            <div className={`rounded-lg border px-3 py-2 ${resultClasses}`}>
              <p className="text-xs font-semibold">{testCopy.title}</p>
              <p className="mt-1 text-xs leading-5 text-[#57606a]">{testCopy.detail}</p>
              {(lastTest?.status === "missing_permissions" || lastTest?.status === "missing_installation" || lastTest?.status === "repo_not_selected") && installUrl && (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex rounded border border-[#0969da] bg-white px-2.5 py-1 text-xs font-medium text-[#0969da] transition-colors hover:bg-[#f6f8fa]"
                >
                  Open GitHub installation
                </a>
              )}
              {lastTest?.status === "missing_permissions" && (
                <a
                  href={createUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => {
                    setWaitingForCreation(true);
                  }}
                  className="mt-2 ml-2 inline-flex rounded border border-[#0969da] bg-[#0969da] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[#0860ca]"
                >
                  Create replacement app
                </a>
              )}
            </div>
          )}
        </div>
      )}
      */}

      {selfUpdateRepoPanel}
      {/*
      {manualOpen && (
        <div className="grid gap-3 rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-3">
          <div>
            <p className="text-xs font-semibold text-[#24292f]">Manual setup values</p>
            <div className="mt-2 grid gap-1 text-xs text-[#57606a]">
              <p>Homepage URL: <code className="text-[#24292f]">{HUB_URL}</code></p>
              <p>Manifest callback URL: <code className="text-[#24292f]">{manifestCallbackUrl}</code></p>
              <p>Setup URL: <code className="text-[#24292f]">{installCallbackUrl}</code></p>
              <p>Required permissions: <code className="text-[#24292f]">metadata: read, contents: write, pull_requests: write</code></p>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <input
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="App ID"
              disabled={saving}
              className="rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
            />
            <input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="Client ID"
              disabled={saving}
              className="rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
            />
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="App slug"
              disabled={saving}
              className="rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
            />
          </div>
          <textarea
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            placeholder="Private key PEM"
            disabled={saving}
            rows={5}
            className="rounded-lg border border-[#d0d7de] bg-white px-3 py-2 font-mono text-xs text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !appId.trim() || !clientId.trim() || !slug.trim() || !privateKey.trim()}
              className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
            >
              {saving ? "Saving..." : "Save GitHub App"}
            </button>
          </div>
          {error && <p className="text-xs text-[#cf222e]">{error}</p>}
        </div>
      )}
      */}
      {error && <p className="text-xs text-[#cf222e]">{error}</p>}
    </div>
  );
}

function selfHostSetupCommand(status: SetupStatus): string {
  const workersDevHubUrl = status.workersDevHubUrl || (status.routeKind === "workers-dev" ? status.hubUrl : "");
  return workersDevHubUrl ? `tiller host setup --hub-url ${workersDevHubUrl}` : "tiller host setup --hub-url <workersDevHubUrl>";
}

function HostingStatusCards({
  status,
  onRefresh,
}: {
  status: SetupStatus;
  onRefresh: () => Promise<void>;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const addToast = useToast();
  const hostRuntime = hostRuntimeStatus(status);
  const gatewayStatus = hostGatewayStatus(status);
  const command = selfHostSetupCommand(status);
  const selfHostActive = status.deploymentMode === "self-host";
  const setupInProgress = status.selfHostStatus === "setup-in-progress";
  const selfHostHealthy = selfHostActive && status.selfHostStatus === "ready";
  const activeClasses = statusToneClasses(selfHostHealthy ? "success" : "warning");
  const showTechnicalDetails = setupInProgress || (selfHostActive && !selfHostHealthy);

  async function handleReturnToHosted() {
    const confirmation = window.prompt('Type "return to hosted" to restore Hosted Tiller on the protected workers.dev URL.');
    if (confirmation?.trim().toLowerCase() !== "return to hosted") return;
    const result = await returnToHostedTiller(HUB_URL);
    addToast({ title: "Returned to Hosted Tiller", variant: "success" });
    if (result.redirectUrl && result.redirectUrl !== window.location.origin) {
      window.location.href = result.redirectUrl;
      return;
    }
    await onRefresh();
  }

  return (
    <div className="grid gap-3">
      <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
        {selfHostActive ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">Tiller Self Host</p>
              <p className={`mt-2 text-sm font-semibold ${activeClasses.title}`}>
                <span className={`mr-2 inline-block h-2 w-2 rounded-full ${activeClasses.dot}`} />
                Tiller Self Host is active
              </p>
              <p className="mt-1 text-xs text-[#57606a]">
                {status.selfHostStatus === "ready" ? "Healthy" : "Needs attention"}
              </p>
            </div>
            <button
              type="button"
              aria-label='Return to Hosted Tiller. Type "return to hosted" to confirm.'
              onClick={() => void handleReturnToHosted()}
              className="rounded-lg border border-[#cf222e]/40 bg-white px-3 py-1.5 text-xs font-medium text-[#cf222e] transition-colors hover:bg-[#fff5f5]"
            >
              Return to Hosted Tiller
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">Hosted Tiller</p>
              <p className="mt-2 text-sm font-semibold text-[#1a7f37]">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#1a7f37]" />
                Hosted Tiller is active
              </p>
              <p className="mt-1 text-xs text-[#57606a]">
                Tiller runs from the protected Cloudflare-hosted hub. Set up Self Host when you are ready to move to an always-on host machine.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSetupOpen(true)}
              className="rounded-lg border border-[#0969da]/30 bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0a5bc4]"
            >
              {setupInProgress ? "Continue Self Host Setup" : "Set up Self Host"}
            </button>
          </div>
        )}
      </div>
      {setupOpen && (
        <div role="dialog" aria-modal="false" aria-label="Set up Self Host" className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[#24292f]">Set up Self Host</p>
              <p className="mt-1 text-xs text-[#57606a]">Run this command on the machine that will host Tiller.</p>
            </div>
            <button
              type="button"
              onClick={() => setSetupOpen(false)}
              className="rounded-lg border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa]"
            >
              Close
            </button>
          </div>
          <div className="mt-3 rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
            <code className="break-words text-xs text-[#24292f]">{command}</code>
          </div>
        </div>
      )}
      {showTechnicalDetails && (
        <details className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-[#24292f]">Technical details</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {[
              { label: "Host runtime", status: hostRuntime },
              { label: "Subscription Gateway", status: gatewayStatus },
            ].map(({ label, status: readiness }) => {
              const classes = statusToneClasses(readiness.tone);
              return (
                <div key={label} className="rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">{label}</p>
                  <p className={`mt-2 text-sm font-semibold ${classes.title}`}>
                    <span className={`mr-2 inline-block h-2 w-2 rounded-full ${classes.dot}`} />
                    {readiness.title}
                  </p>
                  <p className="mt-1 text-xs text-[#57606a]">{readiness.detail}</p>
                </div>
              );
            })}
          </div>
          {setupInProgress && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setSetupOpen(true)}
                className="rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
              >
                Show setup command
              </button>
              <button
                type="button"
                aria-label='Return to Hosted Tiller. Type "return to hosted" to confirm.'
                onClick={() => void handleReturnToHosted()}
                className="rounded-lg border border-[#cf222e]/40 bg-white px-3 py-1.5 text-xs font-medium text-[#cf222e] transition-colors hover:bg-[#fff5f5]"
              >
                Return to Hosted Tiller
              </button>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

// ── Settings page ────────────────────────────────────────────────

export default function SettingsPage({ status, onDone, onRefresh }: SettingsPageProps) {
  const [testResults, setTestResults] = useState<Map<string, VerifyModelAuthResult>>(new Map());
  const [codexImportOpen, setCodexImportOpen] = useState(false);
  const [codexStatusRefreshing, setCodexStatusRefreshing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const addToast = useToast();
  const codexStatus = codexSubscriptionStatus(status);
  const codexImportDisabled = status.hasChatGPTAuth && status.chatgptAuthStatus !== "needs_reconnect";
  const selfHostFeaturesVisible = status.isLocalDev || status.deploymentMode === "self-host";
  const codexVisible =
    status.enabledHarnesses.includes("codex") || status.hasOpenAIKey || (selfHostFeaturesVisible && status.hasChatGPTAuth);
  const opencodeVisible = status.enabledHarnesses.includes("opencode");

  const subscriptionCredentials: CredentialDef[] = [
    ...(selfHostFeaturesVisible
      ? [
          {
            label: "Claude subscription token",
            description: "Use a Claude Code OAuth token from your subscription on Tiller Self Host.",
            secretKey: "CLAUDE_CODE_OAUTH_TOKEN",
            configured: status.hasClaudeSubscription,
            testable: true,
            help: <ClaudeSubscriptionSetupHint />,
          },
        ]
      : []),
  ];
  const apiCredentials: CredentialDef[] = [
    {
      label: "Claude API key",
      secretKey: "ANTHROPIC_API_KEY",
      configured: status.hasAnthropicKey,
      testable: true,
    },
    ...(codexVisible
      ? [
          {
            label: "Codex API key",
            secretKey: "OPENAI_API_KEY",
            configured: status.hasOpenAIKey,
            testable: true,
          },
        ]
      : []),
  ];

  async function handleSave(payload: Record<string, string>) {
    await submitSetup(HUB_URL, payload);
    await onRefresh();
    setTestResults((prev) => {
      const next = new Map(prev);
      for (const key of Object.keys(payload)) {
        next.delete(key);
      }
      return next;
    });
    addToast({ title: "Credential saved", variant: "success" });
  }

  async function handleTest() {
    const response = await verifyModelAuth(HUB_URL);
    const next = new Map<string, VerifyModelAuthResult>();
    for (const result of response.results) {
      next.set(result.key, result);
    }
    setTestResults(next);

    if (response.ok) {
      addToast({ title: "All credentials valid", variant: "success" });
    } else {
      const failed = response.results.filter((r) => !r.ok);
      addToast({
        title: failed.length > 0 ? `${failed.length} credential(s) failed verification` : "Verification failed",
        variant: "error",
      });
    }
  }

  async function handleCodexStatusRefresh() {
    setCodexStatusRefreshing(true);
    try {
      const latest = await fetchSetupStatus(HUB_URL);
      await onRefresh();
      if (latest.chatgptAuthStatus === "connected" || latest.chatgptAuthStatus === "refreshing") {
        const active = latest.openaiPlannerAvailable && latest.openaiPlannerRoute === "subscription-gateway";
        addToast({
          title: active ? "Subscription active" : "Subscription imported",
          body: active
            ? "The OpenAI planner can use the imported Codex subscription."
            : latest.openaiPlannerReason ??
              "The subscription is imported. Tiller Self Host may still need the Subscription Gateway.",
          variant: active ? "success" : "warning",
        });
      } else if (latest.chatgptAuthStatus === "needs_reconnect") {
        addToast({
          title: "Subscription still needs re-import",
          body: "Run the import script again on the computer where Codex is logged in.",
          variant: "warning",
          duration: 8000,
        });
      } else {
        addToast({
          title: "Subscription not imported",
          body: "Run the import script on the computer where Codex is logged in, then check again.",
          variant: "warning",
          duration: 8000,
        });
      }
    } catch (err) {
      addToast({
        title: "Status refresh failed",
        body: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setCodexStatusRefreshing(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#f6f8fa]">
      {codexImportOpen && (
        <CodexImportDialog onClose={() => setCodexImportOpen(false)} />
      )}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
              <h2 className="text-lg font-semibold text-[#24292f]">Settings</h2>
              <p className="mt-1 text-sm text-[#57606a]">
                {status.isLocalDev
                  ? "Manage model access for host environments on this localhost hub. Keep `tiller host` running when you want environments to start."
                  : "Manage model access and hosting status."}
              </p>
            </div>
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm text-[#57606a] transition-colors hover:bg-[#f6f8fa]"
          >
            Back
          </button>
        </div>

        <Card
          title="Hosting"
          description="Hosted Tiller stays on protected workers.dev. Tiller Self Host is a guided graduation to a protected custom domain."
          tone={status.selfHostStatus === "ready" || status.hostedInfrastructureReady ? "success" : "warning"}
        >
          <HostingStatusCards status={status} onRefresh={onRefresh} />
        </Card>

        <Card
          title="Model access"
          description={
            status.modelAuthConfigured
              ? "Manage your Claude and Codex credentials. OpenCode uses the built-in Workers AI proxy."
              : codexVisible || opencodeVisible
                ? "Add Claude or Codex credentials when you want those harnesses. OpenCode uses the built-in Workers AI proxy."
                : "Add a Claude API key or Claude subscription token. This is the only required setup item."
          }
          tone={status.modelAuthConfigured ? "success" : "warning"}
        >
          <div className="grid gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">API Keys</p>
              <div className="mt-3 grid gap-3">
                {opencodeVisible && (
                  <OpenCodeInfoRow />
                )}
                {apiCredentials.map((def) => (
                  <CredentialRow
                    key={def.secretKey}
                    def={def}
                    testResult={testResults.get(def.secretKey) ?? null}
                    onSave={handleSave}
                    onTest={handleTest}
                  />
                ))}
              </div>
            </div>

            {subscriptionCredentials.length > 0 || (codexVisible && selfHostFeaturesVisible) ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">Subscriptions</p>
              <div className="mt-3 grid gap-3">
                {subscriptionCredentials.map((def) => (
                  <CredentialRow
                    key={def.secretKey}
                    def={def}
                    testResult={testResults.get(def.secretKey) ?? null}
                    onSave={handleSave}
                    onTest={handleTest}
                  />
                ))}
                {codexVisible && selfHostFeaturesVisible && (
                  <CodexSubscriptionRow
                    status={status}
                    codexStatus={codexStatus}
                    onImport={() => setCodexImportOpen(true)}
                    importDisabled={codexImportDisabled}
                    onCheckStatus={() => void handleCodexStatusRefresh()}
                    checkingStatus={codexStatusRefreshing}
                  />
                )}
              </div>
            </div>
            ) : null}
          </div>
        </Card>

        <Card
          title="GitHub App"
          description="Use a GitHub App installation for private repository access and pull request permissions."
          tone={status.githubAppConfigured ? "success" : "default"}
        >
          <GitHubAppSettings status={status} onRefresh={onRefresh} />
        </Card>

        <section className="rounded-2xl border border-[#d0d7de] bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[#24292f]">Advanced</h3>
              <p className="mt-1 text-sm text-[#57606a]">Less common environment lifecycle and repository bootstrap settings.</p>
            </div>
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
              className="rounded-lg border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              {advancedOpen ? "Hide advanced" : "Show advanced"}
            </button>
          </div>
          {advancedOpen && (
            <div className="mt-4 grid gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">Environment auto-stop</p>
                <div className="mt-3 grid gap-3">
                  <IdleTimeoutRow
                    currentMinutes={status.idleTimeoutMinutes}
                    onSave={async (minutes) => {
                      await submitSetup(HUB_URL, { IDLE_TIMEOUT_MINUTES: String(minutes) });
                      await onRefresh();
                      addToast({ title: "Idle timeout updated", variant: "success" });
                    }}
                  />
                  <CanonicalMainBootstrapDepthRow
                    currentDepth={status.canonicalMainBootstrapDepth}
                    onSave={async (depth) => {
                      await submitSetup(HUB_URL, { CANONICAL_MAIN_BOOTSTRAP_DEPTH: String(depth) });
                      await onRefresh();
                      addToast({ title: "Canonical history depth updated", variant: "success" });
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </section>

        {status.isLocalDev && (
          <Card
            title="Localhost hub"
            description="This localhost hub is contributor-only and supports the Tiller Self Host backend for local development."
            tone="default"
          >
            <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
              <p className="text-sm font-semibold text-[#24292f]">Browser-first host flow</p>
              <p className="mt-2 text-xs text-[#57606a]">
                Keep <code>npm run dev</code> running here, then start <code>tiller host</code> in a second terminal
                when you want environments to boot. Host Docker containers call back to this hub through
                <code>host.docker.internal</code>.
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
