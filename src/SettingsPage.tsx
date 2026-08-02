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
import type {
  ExecutionStatus,
  SetupStatus,
  VerifyModelAuthResult,
} from "./api";
import {
  fetchExecutionStatus,
  fetchSetupStatus,
  saveBillingMode,
  setExecutionBackend,
  submitSetup,
  verifyModelAuth,
} from "./api";
import type { BillingMode } from "../shared/billing";
import { KIMI_K2_7_CODE } from "../shared/harness-catalog";
import {
  CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
  isCloudflareIdleTimeoutMinutes,
} from "../shared/cloudflare-timeout";

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

function codexSubscriptionStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (status.openaiBillingMode !== "subscription") {
    return {
      title: status.hasChatGPTAuth ? "Configured · inactive" : "Not configured · inactive",
      detail: status.openaiBillingMode === "api"
        ? "OpenAI API mode is active. The connected Codex subscription is not used by new launches."
        : "Select OpenAI Subscription to activate this route for new launches.",
      tone: "neutral",
    };
  }
  if (status.chatgptAuthStatus === "needs_reconnect") {
    return {
      title: "Subscription needs reconnection",
      detail: "Tiller can no longer refresh this Codex subscription. Re-run the CLI connection command.",
      tone: "warning",
    };
  }

  if (status.chatgptAuthStatus === "temporarily_unavailable") {
    return {
      title: "Subscription temporarily unavailable",
      detail: "Tiller preserved the managed login and will retry without switching an active runtime to API billing.",
      tone: "warning",
    };
  }

  if (status.chatgptAuthStatus === "refreshing") {
    return {
      title: "Subscription refreshing",
      detail: "Tiller is refreshing this Hub's Codex subscription connection.",
      tone: "warning",
    };
  }

  if (status.hasChatGPTAuth || status.chatgptAuthStatus === "connected") {
    return {
      title: "Subscription active",
      detail: "Connected to this Hub for Codex workloads and OpenAI planner runs on either execution backend.",
      tone: "success",
    };
  }

  if (status.hasOpenAIKey) {
    return {
      title: "Subscription not connected",
      detail: "The configured OpenAI API key is inactive while OpenAI Subscription mode is selected.",
      tone: "warning",
    };
  }

  return {
    title: "Subscription not connected",
    detail: "Run the Tiller CLI connection command to enable subscription-backed Codex launches.",
    tone: "neutral",
  };
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
      <p className="text-xs font-medium text-kumo-default">Recommended</p>
      <p className="mt-1 text-xs text-kumo-subtle">
        Run <code>tiller auth connect claude</code> from a terminal. Tiller guides you through Claude&apos;s login,
        requests one hidden token paste, and activates subscription billing.
      </p>
      <p className="mt-2 text-xs text-kumo-subtle">
        <span className="font-medium text-kumo-default">Manual fallback:</span>{" "}
        run <code>claude setup-token</code>, then add the printed token here.
      </p>
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
  onCheckStatus,
  checkingStatus,
}: {
  status: SetupStatus;
  codexStatus: ReturnType<typeof codexSubscriptionStatus>;
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

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onCheckStatus}
          loading={checkingStatus}
        >
          {checkingStatus ? "Checking..." : "Check status"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-kumo-subtle">
        {status.hasChatGPTAuth
          ? "Reconnect at any time with "
          : "Connect from a terminal with "}
        <code>tiller auth connect codex</code>.
      </p>
    </div>
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
            Minutes of inactivity before Cloudflare environments and newly started Cloudflare Plan Writers are stopped. This does not affect workloads on Your machine. Default: {CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES}.
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

export default function SettingsPage({
  status,
  onDone,
  onRefresh,
}: SettingsPageProps) {
  const [testResults, setTestResults] = useState<Map<string, VerifyModelAuthResult>>(new Map());
  const [codexStatusRefreshing, setCodexStatusRefreshing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [billingSaving, setBillingSaving] = useState<"claude" | "openai" | null>(null);
  const addToast = useToast();
  const codexStatus = codexSubscriptionStatus(status);
  const opencodeVisible = status.enabledHarnesses.includes("opencode");

  const subscriptionCredentials: CredentialDef[] = [
    {
      label: "Claude subscription token",
      description: "Connect your Claude subscription with the Tiller CLI. Manual token entry remains available as a fallback.",
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
          title: active ? "Subscription active" : "Subscription connected",
          body: active
            ? "The OpenAI planner can use the connected Codex subscription."
            : latest.openaiPlannerReason ??
              "The subscription is connected, but the selected runtime is not ready.",
          variant: active ? "success" : "warning",
        });
      } else if (latest.chatgptAuthStatus === "needs_reconnect") {
        addToast({
          title: "Subscription still needs reconnection",
          body: "Run `tiller auth connect codex` again from a terminal.",
          variant: "warning",
          duration: 8000,
        });
      } else {
        addToast({
          title: "Subscription not connected",
          body: "Run `tiller auth connect codex` from a terminal, then check again.",
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
                  onCheckStatus={() => void handleCodexStatusRefresh()}
                  checkingStatus={codexStatusRefreshing}
                />
              </div>
            </div>
          </div>
        </Card>

        <LayerCard render={<section />} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-kumo-strong">Advanced</h3>
              <p className="mt-1 text-sm text-kumo-subtle">Cloudflare environment lifecycle settings.</p>
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
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">Cloudflare auto-stop</p>
                <div className="mt-3 grid gap-3">
                  <IdleTimeoutRow
                    currentMinutes={status.idleTimeoutMinutes}
                    onSave={async (minutes) => {
                      await submitSetup(HUB_URL, { IDLE_TIMEOUT_MINUTES: String(minutes) });
                      await onRefresh();
                      addToast({ title: "Idle timeout updated", variant: "success" });
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
