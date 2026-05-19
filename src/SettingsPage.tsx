import { useState } from "react";
import type { ReactNode } from "react";
import { useToast } from "./Toast";
import type { SetupStatus, VerifyModelAuthResult } from "./api";
import { submitSetup, verifyModelAuth } from "./api";
import PublishProtectPanel from "./PublishProtectPanel";

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

function codexSubscriptionStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (status.planChatgptAvailable) {
    return {
      title: "ChatGPT planning connected",
      detail: "Hosted Plan is active through the published Tiller Host gateway.",
      tone: "success",
    };
  }

  if (status.hasChatGPTAuth) {
    if (!status.hostRegistered) {
      return {
        title: "ChatGPT connected",
        detail: "Hosted Plan stays inactive until a Tiller Host registers and publishes its gateway.",
        tone: "warning",
      };
    }

    if (!status.hostConnected) {
      return {
        title: "ChatGPT connected",
        detail: "Hosted Plan stays inactive until the registered Tiller Host reconnects.",
        tone: "warning",
      };
    }

    if (!status.hostGatewayConfigured) {
      return {
        title: "ChatGPT connected",
        detail: "Hosted Plan stays inactive until the Tiller Host gateway is configured and published.",
        tone: "warning",
      };
    }

    if (!status.hostGatewayAvailable) {
      return {
        title: "ChatGPT connected",
        detail: "Hosted Plan stays inactive until the published Tiller Host gateway becomes reachable.",
        tone: "warning",
      };
    }

    return {
      title: "ChatGPT connected",
      detail: status.planChatgptReason || "Hosted Plan stays inactive until the published Tiller Host gateway is healthy.",
      tone: "warning",
    };
  }

  if (status.hasOpenAIKey) {
    return {
      title: "OpenAI API fallback configured",
      detail: "Cloudflare Codex environments use the OpenAI API key.",
      tone: "warning",
    };
  }

  return {
    title: "ChatGPT not connected",
    detail: "Connect ChatGPT in Tiller to enable hosted Plan on the Tiller Host gateway.",
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
        : "Connect a Tiller Host machine to this hub to make host environments available.",
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
    detail: "The hub currently has a live route to the registered Tiller Host.",
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
      detail: "The Tiller Host is not publishing a browser gateway yet, so hosted planning stays unavailable.",
      tone: status.hostConnected ? "warning" : "neutral",
    };
  }

  if (!status.hostGatewayAvailable) {
    return {
      title: "Configured, unavailable",
      detail: "A gateway URL is configured, but it is not currently available through the live host connection.",
      tone: "warning",
    };
  }

  return {
    title: "Available",
    detail: status.hostGatewayMode === "named"
      ? "The published gateway is available through a named tunnel."
      : status.hostGatewayMode === "quick"
        ? "The published gateway is available through a quick tunnel."
        : "The published gateway is available.",
    tone: "success",
  };
}

// ── Credential row ───────────────────────────────────────────────

interface CredentialDef {
  label: string;
  description: string;
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
  description: string;
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
          <p className="mt-0.5 text-xs text-[#57606a]">{description}</p>
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
}: {
  status: SetupStatus;
  codexStatus: ReturnType<typeof codexSubscriptionStatus>;
}) {
  return (
    <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] px-4 py-3">
      <p className="text-sm font-semibold text-[#24292f]">Codex subscription via Tiller Host</p>
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

      <div className="mt-3 rounded-lg border border-[#d0d7de] bg-white px-3 py-2">
        <p className="text-xs font-semibold text-[#24292f]">Setup or replace</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-[#57606a]">
          <li>
            On the machine that runs <code>tiller host</code>, run <code>codex login</code> and choose ChatGPT
            subscription auth.
          </li>
          <li>
            Run <code>tiller setup --codex-subscription</code> to sync the local Codex login to this hub.
          </li>
          <li>
            Run <code>tiller doctor</code> to verify the hub sees the Codex subscription.
          </li>
        </ol>
        <p className="mt-2 text-xs text-[#57606a]">
          There is no browser-side token to test or replace here. Tiller reads local Codex auth from{" "}
          <code>~/.codex/auth.json</code> and uses the live Tiller Host gateway when subscription-backed Codex traffic
          needs to leave through that machine.
        </p>
        {!status.hostConnected && (
          <p className="mt-2 text-xs text-[#9a6700]">
            Keep <code>tiller host</code> running when you want host Codex environments or hosted ChatGPT planning to use
            this subscription route.
          </p>
        )}
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

// ── Settings page ────────────────────────────────────────────────

export default function SettingsPage({ status, onDone, onRefresh }: SettingsPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, VerifyModelAuthResult>>(new Map());
  const addToast = useToast();
  const codexStatus = codexSubscriptionStatus(status);
  const hostRuntime = hostRuntimeStatus(status);
  const gatewayStatus = hostGatewayStatus(status);
  const codexVisible =
    status.enabledHarnesses.includes("codex") || status.hasOpenAIKey || status.hasChatGPTAuth;
  const opencodeVisible = status.enabledHarnesses.includes("opencode");

  const subscriptionCredentials: CredentialDef[] = [
    {
      label: "Claude subscription token",
      description: "Use a Claude Code OAuth token from your subscription.",
      secretKey: "CLAUDE_CODE_OAUTH_TOKEN",
      configured: status.hasClaudeSubscription,
      testable: true,
      help: <ClaudeSubscriptionSetupHint />,
    },
  ];
  const apiCredentials: CredentialDef[] = [
    {
      label: "Anthropic API key",
      description: "Use API-billed Claude access. Required for headless container environments.",
      secretKey: "ANTHROPIC_API_KEY",
      configured: status.hasAnthropicKey,
      testable: true,
    },
    ...(codexVisible
      ? [
          {
            label: "OpenAI API key",
            description: "Use API-billed Codex access for Cloudflare Containers.",
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

  return (
    <div className="flex-1 overflow-y-auto bg-[#f6f8fa]">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
              <h2 className="text-lg font-semibold text-[#24292f]">Settings</h2>
              <p className="mt-1 text-sm text-[#57606a]">
                {status.isLocalDev
                  ? "Manage model access for host environments on this localhost hub. Keep `tiller host` running when you want environments to start."
                  : "Manage model access, publish, and browser protection."}
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
          title="Model access"
          description={
            status.modelAuthConfigured
              ? "Manage your Claude and Codex credentials. OpenCode uses the built-in Workers AI proxy."
              : codexVisible || opencodeVisible
                ? "Add Claude or Codex credentials when you want those harnesses. OpenCode uses the built-in Workers AI proxy."
                : "Add an Anthropic API key or Claude subscription token. This is the only required setup item."
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
                {codexVisible && (
                  <CodexSubscriptionRow status={status} codexStatus={codexStatus} />
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="Tiller Host"
          description={
            status.isLocalDev
              ? "Host registration, live connectivity, and gateway publishing are tracked separately on localhost."
              : "Host registration, live connectivity, and gateway availability are tracked separately for the always-on host path."
          }
          tone={status.hostConnected && status.hostGatewayAvailable ? "success" : "warning"}
        >
          <div className="grid gap-3 md:grid-cols-2">
            {[
              {
                label: "Host runtime",
                status: hostRuntime,
              },
              {
                label: "Gateway",
                status: gatewayStatus,
              },
            ].map(({ label, status: readiness }) => {
              const classes = statusToneClasses(readiness.tone);
              return (
                <div key={label} className="rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
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
        </Card>

        <Card
          title="Environment auto-stop"
          description="Automatically stop idle Cloudflare containers to save resources."
          tone="default"
        >
          <div className="grid gap-3">
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
        </Card>

        {status.isLocalDev ? (
          <Card
            title="Localhost hub"
            description="This localhost hub only supports the Tiller Host backend. Publish and Cloudflare Access only matter on deployed hubs."
            tone="default"
          >
            <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
              <p className="text-sm font-semibold text-[#24292f]">Browser-first host flow</p>
              <p className="mt-2 text-xs text-[#57606a]">
                Keep <code>npm run dev</code> running here, then start <code>tiller host</code> in a second terminal
                when you want environments to boot. Host Docker containers call back to this hub through
                <code>host.docker.internal</code>. Hosted ChatGPT planning needs a published host gateway.
              </p>
            </div>
          </Card>
        ) : (
          <Card
            title="Publish & Protect"
            description={
              status.browserProtected && status.gatewayProvisioned
                ? `Your hub is protected at ${status.hubUrl}, and Tiller has provisioned the protected gateway hostname and managed tunnel bootstrap for the always-on host path.`
                : status.browserProtected
                  ? `Your hub is protected at ${status.hubUrl}, but Tiller still needs to provision the protected gateway resources for the always-on host path.`
                  : status.hostKind === "workers-dev"
                    ? `Your hub is currently using ${status.hubUrl}. Publish to your domain when you are ready for the protected setup and browser-assisted CLI bootstrap.`
                    : `Enable browser protection on ${status.hubUrl} so it becomes the supported deployment and can bootstrap the CLI through the browser.`
            }
            tone={status.browserProtected && status.gatewayProvisioned ? "success" : "warning"}
          >
            <PublishProtectPanel
              status={status}
              variant="settings"
              onRefresh={onRefresh}
            />
          </Card>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
