import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { useToast } from "./Toast";
import { getStoredThemePreference, setThemePreference, type ThemePreference } from "./theme";
import type { ExecutionStatus, HubUpdateRepoCandidate, SetupStatus, VerifyModelAuthResult } from "./api";
import {
  detectSelfUpdateRepo,
  fetchExecutionStatus,
  fetchSetupStatus,
  renewWorkersDevAccess,
  saveBillingMode,
  selectSelfUpdateRepo,
  setExecutionBackend,
  submitSetup,
  verifyModelAuth,
} from "./api";
import type { BillingMode } from "../shared/billing";
import { useGitHubRepositories } from "./useGitHubRepositories";
import { KIMI_K2_7_CODE } from "../shared/harness-catalog";
import {
  CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
  isCloudflareIdleTimeoutMinutes,
} from "../shared/cloudflare-timeout";

// Legacy GitHub App controls are commented out inside GitHubAppSettings. If they
// are restored, also restore these imports:
// import type { GitHubAccessTestResult } from "./api";
// import { saveGitHubAppConfig, testGitHubAppAccess } from "./api";
// import { githubRepositoryKey } from "./useGitHubRepositories";

const HUB_URL = window.location.origin;

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
      ? "ring-kumo-success/25 bg-kumo-success-tint"
      : tone === "warning"
        ? "ring-kumo-warning/30 bg-kumo-warning-tint"
        : "";

  return (
    <LayerCard render={<section />} className={`p-5 ${toneClasses}`}>
      <h3 className="text-base font-semibold text-kumo-strong">{title}</h3>
      <p className="mt-1 text-sm text-kumo-subtle">{description}</p>
      <div className="mt-4">{children}</div>
    </LayerCard>
  );
}

function AppearanceRow() {
  const [preference, setPreference] = useState<ThemePreference>(() => getStoredThemePreference());

  return (
    <Select
      label="Theme"
      className="w-[200px]"
      value={preference}
      onValueChange={(value) => {
        const next = (value ?? "system") as ThemePreference;
        setPreference(next);
        setThemePreference(next);
      }}
      items={{ system: "System", light: "Light", dark: "Dark" }}
    />
  );
}

function WorkersDevAccessLifecycleCard({ status }: { status: SetupStatus }) {
  const [renewing, setRenewing] = useState(false);
  const addToast = useToast();
  if (!status.tokenExpiresAt) return null;
  const parsedExpiration = Date.parse(status.tokenExpiresAt);
  const expiration = Number.isFinite(parsedExpiration)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(parsedExpiration))
    : status.tokenExpiresAt;

  async function renew() {
    setRenewing(true);
    try {
      const job = await renewWorkersDevAccess(HUB_URL);
      window.location.assign(job.connectUrl);
    } catch (error) {
      setRenewing(false);
      addToast({
        title: "Cloudflare renewal could not start",
        body: error instanceof Error ? error.message : String(error),
        variant: "error",
      });
    }
  }

  return (
    <Card
      title="Cloudflare Access"
      description={`CLI and agent access valid until ${expiration}`}
      tone={status.renewalRecommended ? "warning" : "success"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-kumo-default">
            CLI and agent access valid until {expiration}
          </p>
          <p className={`mt-1 text-xs ${status.renewalRecommended ? "text-kumo-warning" : "text-kumo-subtle"}`}>
            {status.renewalRecommended
              ? "Renew within 30 days to keep existing CLI, machine, and workload connections active."
              : "Renewal keeps the existing client ID and secret; connected machines and processes do not restart."}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => void renew()} disabled={renewing} loading={renewing}>
          {renewing ? "Opening Cloudflare..." : "Renew with Cloudflare"}
        </Button>
      </div>
    </Card>
  );
}

export function buildCodexImportCommand(hubUrl: string): string {
  return `npx --yes @paperwing-dev/tiller@latest auth import codex --hub-url ${hubUrl}`;
}

function codexSubscriptionStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (status.openaiBillingMode !== "subscription") {
    return {
      title: status.hasChatGPTAuth ? "Configured · inactive" : "Not configured · inactive",
      detail: status.openaiBillingMode === "api"
        ? "OpenAI API mode is active. The imported Codex subscription is not used by new launches."
        : "Select OpenAI Subscription to activate this route for new launches.",
      tone: "neutral",
    };
  }
  if (status.chatgptAuthStatus === "needs_reconnect") {
    return {
      title: "Subscription needs re-import",
      detail: "Tiller can no longer refresh the imported Codex subscription.",
      tone: "warning",
    };
  }

  if (status.chatgptAuthStatus === "temporarily_unavailable") {
    return {
      title: "Subscription temporarily unavailable",
      detail: "Tiller preserved the imported login and will retry without switching an active runtime to API billing.",
      tone: "warning",
    };
  }

  if (status.openaiPlannerAvailable && status.openaiPlannerRoute === "subscription-app-server") {
    return {
      title: "Subscription active",
      detail: "New Codex launch profiles use the imported subscription through the app-server runtime.",
      tone: "success",
    };
  }

  if (status.hasChatGPTAuth || status.chatgptAuthStatus === "refreshing") {
    if (status.codexRouteStatus === "runtime_update_required") {
      return {
        title: "Subscription imported",
        detail: "The selected execution backend needs a compatible runtime update.",
        tone: "warning",
      };
    }
    if (status.codexRouteStatus === "backend_offline") {
      return {
        title: "Subscription imported",
        detail: "The selected execution backend is offline.",
        tone: "warning",
      };
    }
    if (status.codexRouteStatus === "environment_not_connected") {
      return {
        title: "Subscription imported",
        detail: "The selected execution machine is registered but not connected.",
        tone: "warning",
      };
    }
    if (status.codexRouteStatus === "authentication_unavailable") {
      return {
        title: "Authentication unavailable",
        detail: status.openaiPlannerReason || "The selected OpenAI authentication route is unavailable.",
        tone: "warning",
      };
    }

    return {
      title: "Subscription imported",
      detail: status.openaiPlannerReason || "The selected Codex runtime is not ready for a new launch.",
      tone: "warning",
    };
  }

  if (status.hasOpenAIKey) {
    return {
      title: "Subscription not imported",
      detail: "The configured OpenAI API key is inactive while OpenAI Subscription mode is selected.",
      tone: "warning",
    };
  }

  return {
    title: "Subscription not imported",
    detail: "Import an existing Codex subscription to enable subscription-backed Codex launches.",
    tone: "neutral",
  };
}

function codexBackendReadinessLabel(status: SetupStatus["codexRouteStatus"]): string {
  switch (status) {
    case "available": return "Ready";
    case "direct_api": return "API key ready";
    case "backend_offline": return "Backend offline";
    case "runtime_update_required": return "Runtime update required";
    case "environment_not_connected": return "Environment not connected";
    case "authentication_unavailable": return "Authentication unavailable";
    case "unavailable": return "Unavailable";
  }
}

function visibleGitHubOwnersForUpdateRepo(status: SetupStatus["selfUpdateRepo"]): string[] {
  return status.status === "missing" ? status.visibleGitHubOwners : [];
}

function formatVisibleGitHubOwners(owners: string[]): string {
  if (owners.length === 0) return "no GitHub owners";
  if (owners.length === 1) return owners[0];
  return owners.join(", ");
}

// ── Credential row ───────────────────────────────────────────────

interface CredentialDef {
  label: string;
  description?: string;
  secretKey: string;
  configured: boolean;
  active: boolean;
  testable: boolean;
  partial?: boolean;
  help?: ReactNode;
}

function getCredentialStatusChip(state: "configured" | "partial" | "missing", active: boolean): {
  label: string;
  variant: "success" | "warning" | "neutral";
} {
  if (state === "configured") {
    return { label: `Configured · ${active ? "active" : "inactive"}`, variant: active ? "success" : "neutral" };
  }

  if (state === "partial") {
    return { label: `Incomplete · ${active ? "active" : "inactive"}`, variant: "warning" };
  }

  return { label: `Not configured · ${active ? "active" : "inactive"}`, variant: active ? "warning" : "neutral" };
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
      className: "text-kumo-danger",
    };
  }

  if (testResult.warning) {
    return {
      text: `— ${testResult.warning}`,
      className: "text-kumo-warning",
    };
  }

  return {
    text: testResult.note ? `— ${testResult.note}` : fallbackOkText,
    className: "text-kumo-success",
  };
}

function CredentialRowFrame({
  label,
  description,
  status,
  active,
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
  active: boolean;
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
  const statusChip = getCredentialStatusChip(status, active);
  const testResultText = getCredentialTestResultText(testResult, okText);

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">{label}</p>
          {description && <p className="mt-0.5 text-xs text-kumo-subtle">{description}</p>}
          <div className="mt-2 flex items-center gap-2">
            <Badge variant={statusChip.variant} appearance="dot">
              {statusChip.label}
            </Badge>

            {testResultText && (
              <span className={`text-xs ${testResultText.className}`}>
                {testResultText.text}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          {canTest && !editing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onTest()}
              loading={testing}
            >
              {testing ? "Testing..." : "Test"}
            </Button>
          )}
          {!editing && (
            <Button variant="secondary" size="sm" onClick={onStartEdit}>
              {actionLabel}
            </Button>
          )}
        </div>
      </div>

      {children}

      {error && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
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
      active={def.active}
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
          <Input
            type="password"
            size="sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${def.label.toLowerCase()}`}
            aria-label={`Paste ${def.label.toLowerCase()}`}
            autoFocus
            disabled={saving}
            className="flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
            disabled={saving || !value.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setValue("");
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}
    </CredentialRowFrame>
  );
}

function ClaudeSubscriptionSetupHint() {
  return (
    <div className="mt-3 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2">
      <ol className="list-decimal space-y-1 pl-4 text-xs text-kumo-subtle">
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

function BillingModeSelector({
  provider,
  current,
  saving,
  onChange,
}: {
  provider: "Claude" | "OpenAI";
  current: BillingMode | null;
  saving: boolean;
  onChange: (mode: BillingMode) => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-kumo-default">{provider} billing mode</p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            {current ? `${current === "subscription" ? "Subscription" : "API"} is active for new launch claims.` : "No mode selected yet."}
          </p>
        </div>
        <Select
          aria-label={`${provider} billing mode`}
          className="w-[180px]"
          value={current ?? "unselected"}
          onValueChange={(value) => {
            if (value === "subscription" || value === "api") void onChange(value);
          }}
          disabled={saving}
          renderValue={(value) => value === "subscription" ? "Subscription" : value === "api" ? "API" : "Not selected"}
        >
          <Select.Option value="unselected" disabled={current !== null}>Not selected</Select.Option>
          <Select.Option value="subscription">Subscription</Select.Option>
          <Select.Option value="api">API</Select.Option>
        </Select>
      </div>
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
  const credentialStatus = getCredentialStatusChip(
    status.chatgptAuthStatus === "missing" ? "missing" : "configured",
    status.openaiBillingMode === "subscription",
  );
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3">
      <p className="text-sm font-semibold text-kumo-default">Codex Subscription Login</p>
      <div className="mt-2">
        <Badge variant={credentialStatus.variant} appearance="dot">
          {credentialStatus.label}
        </Badge>
      </div>
      <p
        className={`mt-2 text-sm font-medium ${
          codexStatus.tone === "success"
            ? "text-kumo-success"
            : codexStatus.tone === "warning"
              ? "text-kumo-warning"
              : "text-kumo-default"
        }`}
      >
        {codexStatus.title}
      </p>
      <p className="mt-1 text-xs text-kumo-subtle">{codexStatus.detail}</p>

      {status.openaiBillingMode === "subscription" && (
        <dl className="mt-3 grid gap-1 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-kumo-subtle">Cloudflare Containers</dt>
            <dd className="font-medium text-kumo-default">
              {codexBackendReadinessLabel(status.codexBackendReadiness.cf)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-kumo-subtle">Your machine</dt>
            <dd className="font-medium text-kumo-default">
              {codexBackendReadinessLabel(status.codexBackendReadiness.host)}
            </dd>
          </div>
        </dl>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onCheckStatus}
          loading={checkingStatus}
        >
          {checkingStatus ? "Checking..." : "Check status"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onImport}
          disabled={importDisabled}
          title={importDisabled ? "Codex login is already imported. Check status to refresh the connection state." : undefined}
        >
          Import Codex Login
        </Button>
      </div>
      <p className="mt-2 text-xs text-kumo-subtle">
        {importDisabled
          ? "Codex login is already imported. Use Check status to refresh the connection state."
          : "Run the import from the computer where Codex is already logged in."}
      </p>
      {status.hostRegistered && !status.hostConnected && (
        <p className="mt-2 text-xs text-kumo-warning">
          Keep <code>tiller host</code> running when you want Codex workloads or the OpenAI planner on Your machine
          to use this subscription route.
        </p>
      )}
    </div>
  );
}

export function CodexImportDialog({
  onClose,
  onImported,
  hubUrl = HUB_URL,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
  hubUrl?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [importDetected, setImportDetected] = useState(false);
  const command = buildCodexImportCommand(hubUrl);

  useEffect(() => {
    if (importDetected) return;
    let disposed = false;
    let checking = false;

    async function checkForImport() {
      if (checking || disposed) return;
      checking = true;
      try {
        const latest = await fetchSetupStatus(hubUrl);
        if (
          !disposed
          && latest.hasChatGPTAuth
          && (latest.chatgptAuthStatus === "connected" || latest.chatgptAuthStatus === "refreshing")
        ) {
          setImportDetected(true);
          await onImported();
        }
      } catch {
        // The normal Settings status action remains available for actionable errors.
      } finally {
        checking = false;
      }
    }

    const interval = window.setInterval(() => void checkForImport(), 2_000);
    const onFocus = () => void checkForImport();
    window.addEventListener("focus", onFocus);
    void checkForImport();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [hubUrl, importDetected, onImported]);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog size="lg" className="flex max-h-full w-full max-w-3xl flex-col p-0">
        <div className="border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="text-base font-semibold text-kumo-strong">Import Codex Login</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
            Run this on the computer where Codex already works with your subscription.
          </Dialog.Description>
        </div>

        <div className="grid gap-3 overflow-y-auto px-5 py-4">
          <p className="text-sm text-kumo-subtle">
            Run this exact command on the computer where Codex is already logged in. It downloads the latest Tiller CLI
            if needed and imports the login into <code>{new URL(hubUrl).hostname}</code>.
          </p>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
            <code className="min-w-0 flex-1 break-all text-xs text-kumo-default">{command}</code>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void copy()}
            >
              {copied ? "Copied" : "Copy command"}
            </Button>
          </div>
          <p className="text-xs text-kumo-subtle">
            The command reconnects Tiller if it was previously pointed at another Hub, then reports both the destination
            Hub URL and Codex account. Run <code>codex login</code> first if the local login has expired.
          </p>
          <p
            aria-live="polite"
            className={`text-xs ${importDetected ? "font-medium text-kumo-success" : "text-kumo-subtle"}`}
          >
            {importDetected
              ? `Codex subscription imported into ${new URL(hubUrl).hostname}. Settings is up to date.`
              : "Waiting for the import to complete. This page will update automatically."}
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-kumo-line px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="primary" size="sm">
                Done
              </Button>
            )}
          />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function OpenCodeInfoRow() {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">Built-in OpenCode model</p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            {KIMI_K2_7_CODE.label} uses Tiller&apos;s built-in Workers AI binding through the hub proxy. OpenAI-backed
            OpenCode models use the OpenAI API key below.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="success" appearance="dot">
              Built in
            </Badge>
            <span className="text-xs text-kumo-subtle">Pinned to {KIMI_K2_7_CODE.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Idle timeout row ────────────────────────────────────────────

export function IdleTimeoutRow({
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
    const parsed = Number(value);
    if (!isCloudflareIdleTimeoutMinutes(parsed)) {
      setError(`Enter a value between ${CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES} and ${CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES} minutes.`);
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
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">Idle timeout</p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            Minutes of inactivity before Cloudflare environments and newly started Cloudflare Plan Writers are stopped. Default: {CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES}.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="success" appearance="dot">
              {currentMinutes} {currentMinutes === 1 ? "minute" : "minutes"}
            </Badge>
          </div>
        </div>
        {!editing && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setValue(String(currentMinutes));
              setEditing(true);
              setError(null);
            }}
          >
            Change
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex gap-2">
          <Input
            type="number"
            size="sm"
            min={CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES}
            max={CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Idle timeout in minutes"
            autoFocus
            disabled={saving}
            className="w-24"
          />
          <span className="self-center text-xs text-kumo-subtle">minutes</span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
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
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">Canonical main history depth</p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            Full history gives repo-level merge and update jobs complete context. Set a positive value to shallow-clone for faster initial setup.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="success" appearance="dot">
              {currentDepth === 0
                ? "Full history"
                : `${currentDepth} ${currentDepth === 1 ? "commit" : "commits"}`}
            </Badge>
          </div>
        </div>
        {!editing && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setValue(String(currentDepth));
              setEditing(true);
              setError(null);
            }}
          >
            Change
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex gap-2">
          <Input
            type="number"
            size="sm"
            min={0}
            max={200}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Canonical main history depth in commits"
            autoFocus
            disabled={saving}
            className="w-24"
          />
          <span className="self-center text-xs text-kumo-subtle">commits</span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
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
   *   ? "border-kumo-success/25 bg-kumo-success-tint text-kumo-success"
   *   : testCopy?.tone === "warning"
   *     ? "border-kumo-warning/30 bg-kumo-warning-tint text-kumo-warning"
   *     : "border-kumo-danger/25 bg-kumo-danger-tint text-kumo-danger";
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
    <div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-kumo-default">Self-update repo</p>
          <p className="mt-1 text-xs text-kumo-subtle">
            {selfUpdateRepo.status === "detected"
              ? `${selfUpdateRepo.fullName} · ${selfUpdateRepo.branch}`
              : selfUpdateRepo.status === "ambiguous"
                ? "Multiple selected repositories look like Tiller hubs."
                : "Auto-detected when a selected GitHub App repository contains Tiller deploy-button metadata."}
          </p>
        </div>
        {selfUpdateRepo.status !== "detected" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleDetectSelfUpdateRepo()}
            loading={detectingUpdateRepo}
          >
            {detectingUpdateRepo ? "Checking..." : "Connect self-update repo"}
          </Button>
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
              className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-left text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint disabled:opacity-50"
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}
      {selfUpdateRepo.status === "missing" && (
        <div className="mt-3 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2">
          <p className="text-xs font-semibold text-kumo-warning">Check the GitHub account</p>
          <p className="mt-1 text-xs leading-5 text-kumo-subtle">
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
      <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
        <p className="text-sm font-semibold text-kumo-default">Private repo access</p>
        <p className="mt-1 text-xs text-kumo-subtle">
          GitHub App private repo access is available after the workers.dev hub is protected, or on a localhost hub.
        </p>
      </div>
    );
  }

  if (configured && status.githubAppReady) {
    return (
      <div className="grid gap-3">
        <div className="grid gap-2">
          <p className="text-sm font-semibold text-kumo-success">GitHub App configured</p>
          <p className="text-xs leading-5 text-kumo-subtle">
            Tiller can use the repositories selected in this GitHub App installation for private repository access and pull request permissions.
          </p>
          {githubAppUrl ? (
            <div className="mt-1 border-t border-kumo-line pt-3">
              <p className="text-xs font-semibold text-kumo-default">GitHub App URL</p>
              <a
                href={githubAppUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block break-all text-xs font-medium text-kumo-link hover:underline"
              >
                {githubAppUrl}
              </a>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                This is the GitHub App Tiller created for this hub. It is not a repository URL; GitHub uses it to manage which repositories Tiller can access.
              </p>
            </div>
          ) : null}
        </div>
        {selfUpdateRepoPanel}
        {error && <p className="text-xs text-kumo-danger">{error}</p>}
      </div>
    );
  }

  const stepBoxClasses = {
    success: "border-kumo-success/25 bg-kumo-success-tint",
    warning: "border-kumo-warning/30 bg-kumo-warning-tint",
    error: "border-kumo-danger/25 bg-kumo-danger-tint",
    neutral: "border-kumo-line bg-kumo-recessed",
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
    <div className="grid gap-3 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">
            {configured ? "GitHub App configured" : "GitHub App not set up"}
          </p>
          {configured && status.githubAppSlug && (
            <p className="mt-1 text-xs text-kumo-subtle">{status.githubAppSlug}</p>
          )}
        </div>
        {/*
        <div className="flex flex-wrap justify-end gap-2">
          {configured && (
            <a
              href={manageUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
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
            className="rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
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
              <p className="text-xs font-semibold text-kumo-default">1. Create GitHub App</p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">
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
                className="rounded border border-kumo-brand bg-kumo-brand px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-kumo-brand/90"
              >
                Create GitHub App
              </a>
            )}
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 ${stepBoxClasses[repositoryStep.tone]}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-kumo-default">2. Install repositories</p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">{repositoryStep.label}: {repositoryStep.detail}</p>
            </div>
            {configured && installUrl && !allRepositoriesAvailable && (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-kumo-brand bg-kumo-brand px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-kumo-brand/90"
              >
                {repoSelections.length > 0 ? "Install more repos" : "Install repositories"}
              </a>
            )}
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 ${stepBoxClasses[readyStep.tone]}`}>
          <p className="text-xs font-semibold text-kumo-default">3. Use in Tiller</p>
          <p className="mt-1 text-xs leading-5 text-kumo-subtle">{readyStep.label}: {readyStep.detail}</p>
        </div>
      </div>

      {/*
      <div className="grid gap-2 md:grid-cols-3">
        <div className={`rounded-lg border px-3 py-2 ${configured ? "border-kumo-success/25 bg-kumo-success-tint" : "border-kumo-line bg-kumo-recessed"}`}>
          <p className="text-xs font-semibold text-kumo-default">1. Create app</p>
          <p className="mt-1 text-xs text-kumo-subtle">
            {configured
              ? `Created${status.githubAppSlug ? `: ${status.githubAppSlug}` : ""}`
              : waitingForCreation
                ? "Waiting for GitHub to return app config."
                : "Opens GitHub in a new tab."}
          </p>
        </div>
        <div className={`rounded-lg border px-3 py-2 ${configured ? "border-kumo-warning/30 bg-kumo-warning-tint" : "border-kumo-line bg-kumo-recessed"}`}>
          <p className="text-xs font-semibold text-kumo-default">2. Install on repos</p>
          <p className="mt-1 text-xs text-kumo-subtle">
            {configured ? "Select the repositories Tiller can use." : "Available after app creation."}
          </p>
        </div>
        <div className={`rounded-lg border px-3 py-2 ${lastTest?.ok ? "border-kumo-success/25 bg-kumo-success-tint" : "border-kumo-line bg-kumo-recessed"}`}>
          <p className="text-xs font-semibold text-kumo-default">3. Test access</p>
          <p className="mt-1 text-xs text-kumo-subtle">
            {lastTest?.ok ? `Ready for ${lastTest.repo}` : "Verify selected repo access and PR permissions."}
          </p>
        </div>
      </div>
      */}

      {waitingForCreation && !configured && (
        <div className="rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2">
          <p className="text-xs font-semibold text-kumo-warning">Keep this tab open</p>
          <p className="mt-1 text-xs text-kumo-subtle">
            GitHub is open in another tab. Tiller will refresh this page state when the app is created.
          </p>
        </div>
      )}

      {/*
      {configured && (
        <div className="grid gap-2 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-[220px] flex-1 gap-1">
              <span className="text-xs font-medium text-kumo-default">Repository</span>
              <select
                value={selectedRepoKey}
                onChange={(event) => {
                  setSelectedRepoKey(event.target.value);
                  setLastTest(null);
                }}
                disabled={testing || loadingRepos}
                className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:border-kumo-focus focus:outline-none focus:ring-1 focus:ring-kumo-focus/30 disabled:opacity-50"
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
              className="rounded bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-kumo-brand/90 disabled:opacity-40"
            >
              {testing ? "Testing..." : "Test access"}
            </button>
          </div>
          {testCopy && (
            <div className={`rounded-lg border px-3 py-2 ${resultClasses}`}>
              <p className="text-xs font-semibold">{testCopy.title}</p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">{testCopy.detail}</p>
              {(lastTest?.status === "missing_permissions" || lastTest?.status === "missing_installation" || lastTest?.status === "repo_not_selected") && installUrl && (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex rounded border border-kumo-brand bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-link transition-colors hover:bg-kumo-tint"
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
                  className="mt-2 ml-2 inline-flex rounded border border-kumo-brand bg-kumo-brand px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-kumo-brand/90"
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
        <div className="grid gap-3 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
          <div>
            <p className="text-xs font-semibold text-kumo-default">Manual setup values</p>
            <div className="mt-2 grid gap-1 text-xs text-kumo-subtle">
              <p>Homepage URL: <code className="text-kumo-default">{HUB_URL}</code></p>
              <p>Manifest callback URL: <code className="text-kumo-default">{manifestCallbackUrl}</code></p>
              <p>Setup URL: <code className="text-kumo-default">{installCallbackUrl}</code></p>
              <p>Required permissions: <code className="text-kumo-default">metadata: read, contents: write, pull_requests: write</code></p>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <input
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="App ID"
              disabled={saving}
              className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:border-kumo-focus focus:outline-none focus:ring-1 focus:ring-kumo-focus/30 disabled:opacity-50"
            />
            <input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="Client ID"
              disabled={saving}
              className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:border-kumo-focus focus:outline-none focus:ring-1 focus:ring-kumo-focus/30 disabled:opacity-50"
            />
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="App slug"
              disabled={saving}
              className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:border-kumo-focus focus:outline-none focus:ring-1 focus:ring-kumo-focus/30 disabled:opacity-50"
            />
          </div>
          <textarea
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            placeholder="Private key PEM"
            disabled={saving}
            rows={5}
            className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-xs text-kumo-default placeholder:text-kumo-placeholder focus:border-kumo-focus focus:outline-none focus:ring-1 focus:ring-kumo-focus/30 disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !appId.trim() || !clientId.trim() || !slug.trim() || !privateKey.trim()}
              className="rounded bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-kumo-brand/90 disabled:opacity-40"
            >
              {saving ? "Saving..." : "Save GitHub App"}
            </button>
          </div>
          {error && <p className="text-xs text-kumo-danger">{error}</p>}
        </div>
      )}
      */}
      {error && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

function ExecutionBackendCard({ canonicalHubUrl }: { canonicalHubUrl: string }) {
  const [execution, setExecution] = useState<ExecutionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"cf" | "host" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const setupCommand = `tiller host setup --hub-url ${canonicalHubUrl}`;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setExecution(await fetchExecutionStatus(HUB_URL));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const select = async (target: "cf" | "host") => {
    if (!execution) return;
    setSaving(target);
    setError(null);
    try {
      const next = target === "cf"
        ? await setExecutionBackend(HUB_URL, { target: "cf" })
        : execution.candidate.state === "ready"
          ? await setExecutionBackend(HUB_URL, {
              target: "host",
              expectedMachineId: execution.candidate.machineId,
            })
          : null;
      if (next) setExecution(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      await refresh();
    } finally {
      setSaving(null);
    }
  };

  const candidateCopy = !execution || execution.candidate.state === "not_connected"
    ? "No compatible machine is connected."
    : execution.candidate.state === "ready"
      ? `${execution.candidate.displayName} is ready.`
      : `${execution.candidate.displayName} needs an update (${execution.candidate.code.replaceAll("_", " ")}).`;
  const selectedHostCopy = execution?.selectedHost?.state === "offline"
    ? `${execution.selectedHost.displayName} is selected but offline.`
    : execution?.selectedHost?.state === "incompatible"
      ? `${execution.selectedHost.displayName} is selected but needs an update.`
      : execution?.selectedHost?.state === "ready"
        ? `${execution.selectedHost.displayName} is selected and ready.`
        : null;
  const selectedMachineId = execution?.selected.target === "host"
    ? execution.selected.machineId
    : null;
  const candidateSelected = execution?.candidate.state === "ready"
    && execution.candidate.machineId === selectedMachineId;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className={`rounded-xl border px-4 py-3 ${
          execution?.selected.target === "cf"
            ? "border-kumo-success/40 bg-kumo-success-tint"
            : "border-kumo-line bg-kumo-base"
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-kumo-default">Cloudflare Containers</p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                Managed, with no machine to set up or keep online.
              </p>
            </div>
            {execution?.selected.target === "cf" && (
              <Badge variant="success" appearance="dot">Selected</Badge>
            )}
          </div>
          {execution?.selected.target !== "cf" && (
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              loading={saving === "cf"}
              disabled={loading || saving !== null}
              onClick={() => void select("cf")}
            >
              Use Cloudflare
            </Button>
          )}
        </div>

        <div className={`rounded-xl border px-4 py-3 ${
          execution?.selected.target === "host"
            ? "border-kumo-success/40 bg-kumo-success-tint"
            : "border-kumo-line bg-kumo-base"
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-kumo-default">Your machine</p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                Can reduce compute costs and may run faster.
              </p>
            </div>
            {execution?.selected.target === "host" && (
              <Badge
                variant={execution.executionReady ? "success" : "warning"}
                appearance="dot"
              >
                Selected
              </Badge>
            )}
          </div>
          <p className="mt-2 text-xs text-kumo-subtle">
            {selectedHostCopy ?? candidateCopy}
          </p>
          {selectedHostCopy && execution?.candidate.state === "ready"
            && execution.candidate.machineId !== selectedMachineId && (
            <p className="mt-1 text-xs text-kumo-subtle">{candidateCopy}</p>
          )}
          {execution?.candidate.state === "ready" && !candidateSelected && (
            <Button
              className="mt-3"
              variant="primary"
              size="sm"
              loading={saving === "host"}
              disabled={loading || saving !== null}
              onClick={() => void select("host")}
            >
              Use this machine
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
        <p className="text-xs font-medium text-kumo-default">Connect a machine</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-xs text-kumo-default">{setupCommand}</code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(setupCommand).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-kumo-subtle">
        Changes apply only to new workloads. Delete and recreate a workload to use a different backend.
      </p>
      {loading && <p className="text-xs text-kumo-subtle">Checking execution readiness...</p>}
      {error && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

// ── Settings page ────────────────────────────────────────────────

export default function SettingsPage({ status, onDone, onRefresh }: SettingsPageProps) {
  const [testResults, setTestResults] = useState<Map<string, VerifyModelAuthResult>>(new Map());
  const [codexImportOpen, setCodexImportOpen] = useState(false);
  const [codexStatusRefreshing, setCodexStatusRefreshing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [billingSaving, setBillingSaving] = useState<"claude" | "openai" | null>(null);
  const addToast = useToast();
  const codexStatus = codexSubscriptionStatus(status);
  const codexImportDisabled = status.hasChatGPTAuth && status.chatgptAuthStatus !== "needs_reconnect";
  const opencodeVisible = status.enabledHarnesses.includes("opencode");

  const subscriptionCredentials: CredentialDef[] = [
    {
      label: "Claude subscription token",
      description: "Use a Claude Code OAuth token from your subscription.",
      secretKey: "CLAUDE_CODE_OAUTH_TOKEN",
      configured: status.hasClaudeSubscription,
      active: status.claudeBillingMode === "subscription",
      testable: false,
      help: <ClaudeSubscriptionSetupHint />,
    },
  ];
  const apiCredentials: CredentialDef[] = [
    {
      label: "Claude API key",
      secretKey: "ANTHROPIC_API_KEY",
      configured: status.hasAnthropicKey,
      active: status.claudeBillingMode === "api",
      testable: false,
    },
    {
      label: "OpenAI API key",
      description: "Use OpenAI-backed models with Codex or OpenCode.",
      secretKey: "OPENAI_API_KEY",
      configured: status.hasOpenAIKey,
      active: status.openaiBillingMode === "api",
      testable: false,
    },
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

  async function handleBillingMode(provider: "claude" | "openai", mode: BillingMode) {
    setBillingSaving(provider);
    try {
      await saveBillingMode(HUB_URL, provider, mode);
      await onRefresh();
      addToast({
        title: `${provider === "claude" ? "Claude" : "OpenAI"} ${mode === "subscription" ? "Subscription" : "API"} mode active`,
        body: "New launch profiles use this route. Running containers and retained Plan Writers stay pinned until recreated.",
        variant: "success",
      });
    } catch (error) {
      addToast({
        title: `Could not change ${provider === "claude" ? "Claude" : "OpenAI"} billing mode`,
        body: error instanceof Error ? error.message : String(error),
        variant: "error",
      });
    } finally {
      setBillingSaving(null);
    }
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
        const active = latest.openaiPlannerAvailable && latest.openaiPlannerRoute === "subscription-app-server";
        addToast({
          title: active ? "Subscription active" : "Subscription imported",
          body: active
            ? "The OpenAI planner can use the imported Codex subscription."
            : latest.openaiPlannerReason ??
              "The subscription is imported, but the selected runtime is not ready.",
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
    <div className="flex-1 overflow-y-auto bg-kumo-recessed">
      {codexImportOpen && (
        <CodexImportDialog
          onClose={() => setCodexImportOpen(false)}
          onImported={onRefresh}
        />
      )}
      <div className="border-b border-kumo-line bg-kumo-base px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-kumo-strong">Global Settings</h2>
            <p className="mt-1 text-sm text-kumo-subtle">
              {status.isLocalDev
                ? "Manage model access for workloads on Your machine in this localhost Hub. Keep `tiller host` running when you want workloads to start."
                : "Manage model access and the execution backend for new workloads."}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
        <Card
          title="Appearance"
          description="Choose how Tiller looks on this device. System follows your OS preference."
        >
          <AppearanceRow />
        </Card>

        <WorkersDevAccessLifecycleCard status={status} />

        <Card
          title="Execution backend"
          description="Choose where new workloads run."
          tone="default"
        >
          <ExecutionBackendCard canonicalHubUrl={status.workersDevHubUrl ?? HUB_URL} />
        </Card>

        <Card
          title="Model access"
          description={
            status.modelAuthConfigured
              ? "Manage model credentials. OpenCode includes Kimi through Workers AI and can also use OpenAI-backed models."
              : "Add credentials for Claude, Codex, or OpenAI-backed OpenCode models. Kimi uses the built-in Workers AI proxy."
          }
          tone={status.modelAuthConfigured ? "success" : "warning"}
        >
          <div className="grid gap-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <BillingModeSelector
                provider="Claude"
                current={status.claudeBillingMode}
                saving={billingSaving === "claude"}
                onChange={(mode) => handleBillingMode("claude", mode)}
              />
              <BillingModeSelector
                provider="OpenAI"
                current={status.openaiBillingMode}
                saving={billingSaving === "openai"}
                onChange={(mode) => handleBillingMode("openai", mode)}
              />
            </div>
            <p className="text-xs text-kumo-subtle">
              Saving a credential does not activate it. Mode changes apply to newly claimed launch profiles; running containers and retained Plan Writer runtimes remain pinned until recreated.
            </p>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">API Keys</p>
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

            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">Subscriptions</p>
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
                <CodexSubscriptionRow
                  status={status}
                  codexStatus={codexStatus}
                  onImport={() => setCodexImportOpen(true)}
                  importDisabled={codexImportDisabled}
                  onCheckStatus={() => void handleCodexStatusRefresh()}
                  checkingStatus={codexStatusRefreshing}
                />
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="GitHub App"
          description="Use a GitHub App installation for private repository access and pull request permissions."
          tone={status.githubAppConfigured ? "success" : "default"}
        >
          <GitHubAppSettings status={status} onRefresh={onRefresh} />
        </Card>

        <LayerCard render={<section />} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-kumo-strong">Advanced</h3>
              <p className="mt-1 text-sm text-kumo-subtle">Less common environment lifecycle and repository bootstrap settings.</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              {advancedOpen ? "Hide advanced" : "Show advanced"}
            </Button>
          </div>
          {advancedOpen && (
            <div className="mt-4 grid gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">Environment auto-stop</p>
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
        </LayerCard>

        {status.isLocalDev && (
          <Card
            title="Localhost hub"
            description="This localhost Hub is contributor-only and supports Your machine for local development."
            tone="default"
          >
            <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-4">
              <p className="text-sm font-semibold text-kumo-default">Browser-first host flow</p>
              <p className="mt-2 text-xs text-kumo-subtle">
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
