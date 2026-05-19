import { useMemo, useState } from "react";
import type { SetupStatus } from "./api";
import {
  ApiActionError,
  provisionMachineHosts,
  publishProtectHub,
  setupCloudflareAccess,
  verifyCloudflareToken,
} from "./api";
import { parseEmailList } from "./setup-utils";
import { useToast } from "./Toast";

const HUB_URL = window.location.origin;
const CLOUDFLARE_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

interface InlineErrorState {
  message: string;
  hint?: string | null;
  missingPermissions: string[];
}

interface VerifiedTokenState {
  hostname: string;
  zoneName: string;
  workerServiceName: string | null;
}

export interface PublishProtectResult {
  status: SetupStatus;
  hubUrl: string;
  hostname: string;
  appDomain: string | null;
}

interface PublishProtectPanelProps {
  status: SetupStatus;
  variant: "wizard" | "settings";
  onRefresh: () => Promise<void>;
  onBack?: () => void;
  onContinue?: (result: PublishProtectResult | null) => void;
}

export default function PublishProtectPanel({
  status,
  variant,
  onRefresh,
  onBack,
  onContinue,
}: PublishProtectPanelProps) {
  const [pendingAction, setPendingAction] = useState<"idle" | "verify" | "publish" | "access" | "provision-hosts">("idle");
  const [error, setError] = useState<InlineErrorState | null>(null);
  const [hostname, setHostname] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [emailsInput, setEmailsInput] = useState("");
  const [skipForNow, setSkipForNow] = useState(status.hostKind === "workers-dev");
  const [result, setResult] = useState<PublishProtectResult | null>(null);

  const [verifiedToken, setVerifiedToken] = useState<VerifiedTokenState | null>(null);
  const [verifiedTokenKey, setVerifiedTokenKey] = useState<string | null>(null);
  const addToast = useToast();

  const emails = useMemo(() => parseEmailList(emailsInput), [emailsInput]);
  const busy = pendingAction !== "idle";
  const effectiveStatus = result?.status ?? status;
  const effectiveHubUrl = result?.hubUrl ?? effectiveStatus.hubUrl;
  const effectiveHostname = result?.hostname ?? new URL(effectiveHubUrl).hostname;
  const effectiveWorkersDevAliasDisabled = effectiveStatus.workersDevAliasDisabled;
  const effectiveAppDomain = result?.appDomain ?? effectiveStatus.protectionAppDomain;
  const currentState = effectiveStatus.hostKind === "workers-dev"
    ? "workers-dev"
    : !effectiveStatus.browserProtected
      ? "custom-domain-public"
      : effectiveStatus.gatewayProvisioned
        ? "protected"
        : "protected-needs-machine-hosts";
  const targetHostname = (currentState === "workers-dev" ? hostname : effectiveHostname).trim().toLowerCase();

  function resetFeedback(): void {
    setError(null);
  }

  function clearVerification(): void {
    setVerifiedToken(null);
    setVerifiedTokenKey(null);
  }

  function setInlineErrorFromUnknown(err: unknown): void {
    if (err instanceof ApiActionError) {
      setError({
        message: err.message,
        hint: err.hint ?? null,
        missingPermissions: err.missingPermissions,
      });
      return;
    }

    setError({
      message: err instanceof Error ? err.message : "Unexpected error",
      hint: null,
      missingPermissions: [],
    });
  }

  function updateHostname(next: string): void {
    setHostname(next);
    resetFeedback();
    clearVerification();
  }

  function updateApiToken(next: string): void {
    setApiToken(next);
    resetFeedback();
    clearVerification();
  }

  function updateEmails(next: string): void {
    setEmailsInput(next);
    resetFeedback();
  }

  function getVerificationKey(nextHostname: string, token: string): string {
    return `${nextHostname.trim().toLowerCase()}::${token.trim()}`;
  }

  async function ensureVerifiedToken(nextHostname: string): Promise<boolean> {
    const trimmedHostname = nextHostname.trim();
    const trimmedToken = apiToken.trim();
    if (!trimmedHostname) {
      setError({
        message: "Enter the custom domain you want to publish.",
        hint: null,
        missingPermissions: [],
      });
      return false;
    }
    if (!trimmedToken) {
      setError({
        message: "Paste a Cloudflare API token to continue.",
        hint: null,
        missingPermissions: [],
      });
      return false;
    }

    const verificationKey = getVerificationKey(trimmedHostname, trimmedToken);
    if (verifiedTokenKey === verificationKey && verifiedToken) {
      return true;
    }

    setPendingAction("verify");
    setError(null);
    try {
      const next = await verifyCloudflareToken(HUB_URL, {
        hostname: trimmedHostname,
        apiToken: trimmedToken,
      });
      setVerifiedToken({
        hostname: next.hostname,
        zoneName: next.zoneName,
        workerServiceName: next.workerServiceName,
      });
      setVerifiedTokenKey(verificationKey);
      return true;
    } catch (err) {
      clearVerification();
      setInlineErrorFromUnknown(err);
      return false;
    } finally {
      setPendingAction("idle");
    }
  }

  async function handleVerifyToken(): Promise<void> {
    await ensureVerifiedToken(targetHostname);
  }

  async function handlePublishProtect(): Promise<void> {
    if (!hostname.trim()) {
      setError({ message: "Enter the custom domain you want to publish.", hint: null, missingPermissions: [] });
      return;
    }
    if (emails.length === 0) {
      setError({
        message: "Enter at least one email address to allow through Cloudflare Access.",
        hint: null,
        missingPermissions: [],
      });
      return;
    }
    if (!(await ensureVerifiedToken(hostname))) {
      return;
    }

    setPendingAction("publish");
    setError(null);
    try {
      const next = await publishProtectHub(HUB_URL, {
        hostname: hostname.trim(),
        apiToken: apiToken.trim(),
        emails,
      });
      const publishResult: PublishProtectResult = {
        status: next.status,
        hubUrl: next.hubUrl,
        hostname: next.hostname,
        appDomain: next.appDomain,
      };
      setResult(publishResult);
      await onRefresh();
      addToast({
        title: next.status.gatewayProvisioned ? "Hub published and protected" : "Hub browser protection is ready",
        body: next.status.gatewayProvisioned
          ? next.hostname
          : "Provision the protected gateway next to enable the always-on host tunnel.",
        variant: "success",
        duration: 5000,
      });
    } catch (err) {
      setInlineErrorFromUnknown(err);
    } finally {
      setPendingAction("idle");
    }
  }

  async function handleEnableAccess(): Promise<void> {
    if (emails.length === 0) {
      setError({
        message: "Enter at least one email address to allow through Cloudflare Access.",
        hint: null,
        missingPermissions: [],
      });
      return;
    }
    if (!(await ensureVerifiedToken(effectiveHostname))) {
      return;
    }

    setPendingAction("access");
    setError(null);
    try {
      const next = await setupCloudflareAccess(HUB_URL, {
        apiToken: apiToken.trim(),
        emails,
      });
      const publishResult: PublishProtectResult = {
        status: next.status,
        hubUrl: next.hubUrl,
        hostname: next.hostname,
        appDomain: next.appDomain,
      };
      setResult(publishResult);
      await onRefresh();
      addToast({
        title: "Browser protection enabled",
        body: next.hostname,
        variant: "success",
        duration: 5000,
      });
    } catch (err) {
      setInlineErrorFromUnknown(err);
    } finally {
      setPendingAction("idle");
    }
  }

  async function handleProvisionMachineHosts(): Promise<void> {
    if (!(await ensureVerifiedToken(effectiveHostname))) {
      return;
    }

    setPendingAction("provision-hosts");
    setError(null);
    try {
      const next = await provisionMachineHosts(HUB_URL, {
        apiToken: apiToken.trim(),
      });
      const publishResult: PublishProtectResult = {
        status: next.status,
        hubUrl: next.hubUrl,
        hostname: next.hostname,
        appDomain: effectiveStatus.protectionAppDomain,
      };
      setResult(publishResult);
      await onRefresh();
      addToast({
        title: "Protected gateway provisioning is ready",
        body: next.hostname,
        variant: "success",
        duration: 5000,
      });
    } catch (err) {
      setInlineErrorFromUnknown(err);
    } finally {
      setPendingAction("idle");
    }
  }

  if (currentState === "protected") {
    return (
      <div className="grid gap-4">
        <div className="rounded-xl border border-[#1a7f37]/20 bg-white px-4 py-4">
          <p className="text-sm font-semibold text-[#24292f]">Your hub is protected at <code>{effectiveHubUrl}</code></p>
          <p className="mt-2 text-xs text-[#57606a]">
            Browser access is handled by Cloudflare Access. {effectiveWorkersDevAliasDisabled
              ? "The old workers.dev URL is disabled."
              : "The old workers.dev URL is still active."}
          </p>
          <p className="mt-2 text-xs text-[#57606a]">
            Tiller manages a dedicated Cloudflare Access app for <code>{effectiveAppDomain ?? effectiveHostname}</code>.
          </p>
          {!effectiveWorkersDevAliasDisabled && (
            <p className="mt-2 text-xs text-[#57606a]">
              Use <code>{effectiveHubUrl}</code> as the canonical hub URL. The old <code>workers.dev</code> address is still available during cutover.
            </p>
          )}
        </div>

        {variant === "wizard" && onContinue && (
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onBack}
              disabled={busy}
              className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm text-[#57606a] transition-colors hover:bg-[#f6f8fa]"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => onContinue(result)}
              className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4]"
            >
              Continue
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <p className="font-medium">{error.message}</p>
            {error.hint && <p className="mt-2 text-xs text-red-700/90">{error.hint}</p>}
            {error.missingPermissions.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-700/90">Check these permissions</p>
                <ul className="mt-2 list-disc pl-5 text-xs text-red-700/90">
                  {error.missingPermissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const needsMachineHosts = currentState === "protected-needs-machine-hosts";

  const isWorkersDev = currentState === "workers-dev";

  return (
    <div className="grid gap-4">
      {isWorkersDev ? (
        <>
          <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
            <p className="text-sm font-semibold text-[#24292f]">Your hub is live at <code>{status.currentOrigin}</code></p>
            <p className="mt-2 text-xs text-[#57606a]">
              Keep this public bootstrap URL, or publish to your own domain and protect it with Cloudflare Access in one step.
            </p>
            <p className="mt-2 text-xs text-[#57606a]">
              For Tiller CLI access, install <code>tiller</code> and run <code>tiller</code>. When you want an always-on Tiller Host, run <code>tiller host</code> on that machine. This <code>workers.dev</code> hub stays public and uses quick tunnels automatically.
            </p>
            {status.unsupportedProtectionConfig && (
              <p className="mt-3 text-xs text-[#b54708]">
                This workers.dev deployment still has stale Cloudflare Access values configured. They are ignored here.
              </p>
            )}
          </div>

          {variant === "wizard" && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
              <input
                type="checkbox"
                checked={skipForNow}
                onChange={(e) => setSkipForNow(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-semibold text-[#24292f]">Keep the workers.dev URL public for now</p>
                <p className="mt-1 text-xs text-[#57606a]">
                  You can come back to Publish & Protect from Settings whenever you are ready.
                </p>
              </div>
            </label>
          )}
        </>
      ) : needsMachineHosts ? (
        <div className="rounded-xl border border-[#d4a72c]/30 bg-white px-4 py-4">
          <p className="text-sm font-semibold text-[#24292f]">Finish protected gateway provisioning for <code>{effectiveHubUrl}</code></p>
          <p className="mt-2 text-xs text-[#57606a]">
            Your hub is already protected with Cloudflare Access, but Tiller still needs to provision the dedicated
            protected gateway hostname, managed tunnel bootstrap, and DNS record for the always-on host path.
          </p>
          <p className="mt-2 text-xs text-[#57606a]">
            Use the action below with a Cloudflare API token. Tiller will keep the current browser access policy and only
            provision the protected gateway resources.
          </p>
          {effectiveStatus.workersDevCutoverPending && (
            <p className="mt-2 text-xs text-[#57606a]">
              Your custom domain is now the canonical hub URL, but the old <code>workers.dev</code> address is still active until cutover finishes.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-[#d4a72c]/30 bg-white px-4 py-4">
          <p className="text-sm font-semibold text-[#24292f]">Enable browser protection for <code>{effectiveHubUrl}</code></p>
          <p className="mt-2 text-xs text-[#57606a]">
            This custom-domain deployment needs Cloudflare Access before it becomes a supported final state.
          </p>
          <p className="mt-2 text-xs text-[#57606a]">
            Once protected, Tiller CLI access starts with <code>tiller</code>. Run <code>tiller host</code> on your always-on machine when you want host environments. The first attach opens a browser sign-in, and headless machines can finish that flow by pasting the connection code from the browser into the terminal.
          </p>
        </div>
      )}

      {(!isWorkersDev || !skipForNow || variant === "settings") && (
        <div className="grid gap-3 rounded-xl border border-[#d0d7de] bg-white p-4">
          <div className="rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-3 text-xs text-[#57606a]">
            <p className="font-semibold text-[#24292f]">Create a Cloudflare API token</p>
            <p className="mt-1">
              In Cloudflare, go to <code>My Profile</code> → <code>API Tokens</code>, start from <code>Edit Cloudflare Workers</code>, then add these extra rows in the token editor.
            </p>
            <ul className="mt-3 list-disc pl-5">
              <li><code>Account</code> / <code>Access: Apps and Policies</code> / <code>Edit</code></li>
              <li><code>Account</code> / <code>Access: Service Tokens</code> / <code>Edit</code> if your dashboard exposes it</li>
              <li><code>Account</code> / <code>Cloudflare Tunnel</code> / <code>Edit</code></li>
              <li><code>Zone</code> / <code>DNS</code> / <code>Edit</code></li>
            </ul>
            <p className="mt-3">
              Scope the token to the account and zone that own this hostname. If your dashboard does not show <code>Access: Service Tokens</code>, create the token from an account role that can manage Zero Trust service tokens.
            </p>
            <a
              href={CLOUDFLARE_TOKENS_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex text-xs font-medium text-[#0969da] hover:underline"
            >
              Open Cloudflare API Tokens
            </a>
          </div>

          {isWorkersDev && (
            <input
              type="text"
              value={hostname}
              onChange={(e) => updateHostname(e.target.value)}
              placeholder="tiller.example.com"
              disabled={busy}
              className="w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30"
            />
          )}
          <input
            type="password"
            value={apiToken}
            onChange={(e) => updateApiToken(e.target.value)}
            placeholder="Cloudflare API token"
            disabled={busy}
            className="w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleVerifyToken()}
              disabled={busy || !targetHostname || !apiToken.trim()}
              className="rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-40"
            >
              {pendingAction === "verify" ? "Verifying..." : "Verify token"}
            </button>
          </div>
          {verifiedToken && (
            <div className="rounded-lg border border-[#1a7f37]/20 bg-[#f6ffed] px-3 py-3 text-xs text-[#1a7f37]">
              <p className="font-medium">Token verified for <code>{verifiedToken.zoneName}</code></p>
              <p className="mt-1">
                Tiller can reach {verifiedToken.hostname}
                {verifiedToken.workerServiceName ? (
                  <> and found Worker service <code>{verifiedToken.workerServiceName}</code>.</>
                ) : "."}
              </p>
            </div>
          )}
          {!needsMachineHosts && (
            <>
              <textarea
                value={emailsInput}
                onChange={(e) => updateEmails(e.target.value)}
                rows={3}
                placeholder="you@example.com, teammate@example.com"
                disabled={busy}
                className="w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30"
              />
              <p className="text-[11px] text-[#57606a]">
                Tiller will create or reuse a dedicated exact-host Cloudflare Access app for this hostname. These emails are used for the browser allow policy, and Tiller will also keep a machine service token behind the scenes so protected-hub CLI bootstrap can complete through the browser. The target hostname must not already be covered by a wildcard Cloudflare Access app.
              </p>
            </>
          )}
        </div>
      )}

      {variant === "wizard" ? (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm text-[#57606a] transition-colors hover:bg-[#f6f8fa]"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (isWorkersDev && skipForNow) {
                onContinue?.(null);
                return;
              }
              void (isWorkersDev
                ? handlePublishProtect()
                : needsMachineHosts
                  ? handleProvisionMachineHosts()
                  : handleEnableAccess());
            }}
            disabled={busy}
            className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {pendingAction === "publish" || pendingAction === "access" || pendingAction === "provision-hosts"
              ? "Saving..."
              : isWorkersDev && skipForNow
                ? "Continue"
                : needsMachineHosts
                  ? "Provision machine hosts"
                  : isWorkersDev
                    ? "Publish & Protect"
                    : "Enable browser protection"}
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void (isWorkersDev ? handlePublishProtect() : needsMachineHosts ? handleProvisionMachineHosts() : handleEnableAccess())}
            disabled={busy || (isWorkersDev ? (!hostname.trim() || !apiToken.trim() || emails.length === 0) : (!apiToken.trim() || (!needsMachineHosts && emails.length === 0)))}
            className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {pendingAction === "publish" || pendingAction === "access" || pendingAction === "provision-hosts"
              ? "Saving..."
              : needsMachineHosts
                ? "Provision protected machine hosts"
                : isWorkersDev
                  ? "Publish & Protect"
                  : "Enable browser protection"}
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="font-medium">{error.message}</p>
          {error.hint && <p className="mt-2 text-xs text-red-700/90">{error.hint}</p>}
          {error.missingPermissions.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-red-700/90">Check these permissions</p>
              <ul className="mt-2 list-disc pl-5 text-xs text-red-700/90">
                {error.missingPermissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
