import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import type { GitHubAccessTestResult, SetupStatus } from "./api";
import { ApiActionError, detectSelfUpdateRepo, setupWorkersDevAccess, submitSetup, testGitHubAppAccess } from "./api";
import { githubRepositoryKey, useGitHubRepositories } from "./useGitHubRepositories";

const HUB_URL = window.location.origin;
const ACCESS_PROPAGATION_WAIT_SECONDS = 15;

function workerDomainsDashboardUrl(workerName: string): string {
  return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${encodeURIComponent(workerName)}/production/domains`;
}

type ModelAuthMode = "subscription" | "api" | "api-key";

function SetupSteps({ active }: { active: "access" | "github" }) {
  const steps: Array<{ id: "access" | "github"; label: string }> = [
    { id: "access", label: "Protect hub" },
    { id: "github", label: "Connect GitHub" },
  ];

  return (
    <div className="mb-6 grid gap-2 sm:grid-cols-2">
      {steps.map((step, index) => {
        const done = active === "github" && step.id === "access";
        const current = active === step.id;
        return (
          <div
            key={step.id}
            className={`rounded-lg border px-3 py-2 ${
              done
                ? "border-[#1a7f37]/25 bg-[#f0fff4]"
                : current
                  ? "border-[#0969da]/40 bg-[#ddf4ff]"
                  : "border-[#d0d7de] bg-white"
            }`}
          >
            <p className="text-xs font-semibold text-[#24292f]">Step {index + 1} of 2</p>
            <p className="mt-1 text-sm font-medium text-[#24292f]">{step.label}</p>
          </div>
        );
      })}
    </div>
  );
}

interface SetupWizardProps {
  status: SetupStatus;
  onRefresh: () => Promise<void>;
}

export default function SetupWizard({ status, onRefresh }: SetupWizardProps) {
  const [busyAction, setBusyAction] = useState<"model" | "verify-access" | "test-github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [waitingForGitHub, setWaitingForGitHub] = useState(false);
  const [accessWaitUntil, setAccessWaitUntil] = useState<number | null>(null);
  const [accessWaitNow, setAccessWaitNow] = useState(() => Date.now());
  const accessAutoReloadedRef = useRef(false);
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
  const [githubTest, setGithubTest] = useState<GitHubAccessTestResult | null>(null);
  const busy = busyAction !== null;
  const githubRepositories = useGitHubRepositories(HUB_URL, {
    enabled: status.setupPhase === "github-app" && status.githubAppConfigured && !status.githubAppPublicHubDisabled,
  });
  const selectedRepo = githubRepositories.repositories.find(
    (selection) => githubRepositoryKey(selection) === selectedRepoKey,
  ) ?? null;
  const selfHostModelOptions = status.isLocalDev || status.deploymentMode === "self-host";
  const initialModelMode: ModelAuthMode =
    selfHostModelOptions && status.modelAuthMode === "subscription"
    || status.modelAuthMode === "api"
    || status.modelAuthMode === "api-key"
      ? status.modelAuthMode
      : selfHostModelOptions && status.hasClaudeSubscription
        ? "subscription"
        : status.hasOpenAIKey
          ? "api-key"
          : "api";
  const [modelMode, setModelMode] = useState<ModelAuthMode>(initialModelMode);
  const [modelCredential, setModelCredential] = useState("");
  const addToast = useToast();
  const codexVisible =
    status.enabledHarnesses.includes("codex") || status.hasOpenAIKey || status.hasChatGPTAuth;

  useEffect(() => {
    if (!githubRepositories.repositories.length) {
      setSelectedRepoKey("");
      return;
    }
    setSelectedRepoKey((current) => {
      return githubRepositories.repositories.some((selection) => githubRepositoryKey(selection) === current)
        ? current
        : githubRepositoryKey(githubRepositories.repositories[0]);
    });
  }, [githubRepositories.repositories]);

  useEffect(() => {
    function handleFocus() {
      if (status.setupPhase === "github-app") void onRefresh();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [onRefresh, status.setupPhase]);

  useEffect(() => {
    if (!accessWaitUntil) return undefined;
    const reloadAfterWait = () => {
      if (accessAutoReloadedRef.current) return;
      accessAutoReloadedRef.current = true;
      setAccessWaitUntil(null);
      window.location.reload();
    };

    if (Date.now() >= accessWaitUntil) {
      reloadAfterWait();
      return undefined;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      setAccessWaitNow(now);
      if (now >= accessWaitUntil) {
        reloadAfterWait();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [accessWaitUntil]);

  async function advanceModelAccess() {
    if (!modelCredential.trim()) {
      setError("Enter a credential to continue.");
      setErrorHint(null);
      return;
    }

    setBusyAction("model");
    setError(null);
    setErrorHint(null);
    try {
      await submitSetup(HUB_URL, {
        [modelMode === "subscription"
          ? "CLAUDE_CODE_OAUTH_TOKEN"
          : modelMode === "api"
            ? "ANTHROPIC_API_KEY"
            : "OPENAI_API_KEY"]: modelCredential.trim(),
      });
      await onRefresh();
      addToast({
        title: "Setup complete",
        body: "Model access is saved. Open Settings when you want to publish, protect, or prepare CLI access.",
        variant: "success",
      });
      setModelCredential("");
    } catch (err) {
      setError((err as Error).message);
      setErrorHint(null);
    } finally {
      setBusyAction(null);
    }
  }

  const accessWaitRemaining = accessWaitUntil
    ? Math.max(0, Math.ceil((accessWaitUntil - accessWaitNow) / 1000))
    : 0;
  const accessWaitActive = accessWaitRemaining > 0;

  async function verifyWorkersDevAccess() {
    setBusyAction("verify-access");
    setError(null);
    setErrorHint(null);
    try {
      const nextStatus = await setupWorkersDevAccess(HUB_URL);
      await onRefresh();
      addToast({
        title: "Access verified",
        body: nextStatus.setupPhase === "complete"
          ? "Tiller is ready."
          : "Cloudflare Access is saved. Continue with GitHub setup.",
        variant: "success",
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Cloudflare Access did not send a valid JWT. If you just enabled Access, wait a bit, reload through Access, then verify again.",
      );
      setErrorHint(err instanceof ApiActionError && err.hint
        ? err.hint
        : "Cloudflare Access can take about 30 seconds to start sending the JWT after you turn it on. Reload this page after the wait, sign in if prompted, then verify again.");
    } finally {
      setBusyAction(null);
    }
  }

  async function testGitHubAccess() {
    if (!selectedRepo) {
      setError("Select a repository before testing GitHub access.");
      setErrorHint(null);
      return;
    }

    setBusyAction("test-github");
    setError(null);
    setErrorHint(null);
    setGithubTest(null);
    try {
      const result = await testGitHubAppAccess(HUB_URL, selectedRepo);
      setGithubTest(result);
      if (result.ok) {
        await detectSelfUpdateRepo(HUB_URL).catch(() => null);
        await onRefresh();
        addToast({
          title: "GitHub ready",
          body: `Tiller can use ${result.repo ?? selectedRepo.fullName}.`,
          variant: "success",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub access check failed.");
      setErrorHint(null);
    } finally {
      setBusyAction(null);
    }
  }

  if (status.setupPhase === "protect-hub") {
    const hubHostname = new URL(status.currentOrigin || status.hubUrl).hostname;
    const workerLabel = status.workerServiceName || hubHostname.split(".")[0] || "this Worker";
    const workerDomainsUrl = workerDomainsDashboardUrl(workerLabel);
    return (
      <div className="flex-1 overflow-y-auto bg-white">
        <main className="mx-auto w-full max-w-3xl px-6 py-8">
          <SetupSteps active="access" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#57606a]">Required setup</p>
          <h1 className="mt-2 text-2xl font-semibold text-[#24292f]">Protect this hub</h1>
          <p className="mt-2 text-sm text-[#57606a]">
            Cloudflare Access must protect <code>{hubHostname}</code> before Tiller accepts model keys,
            repositories, environments, or CLI setup.
          </p>

          <section className="mt-6 rounded-xl border border-[#d0d7de] bg-white p-5">
            <h2 className="text-base font-semibold text-[#24292f]">Enable Access in Cloudflare</h2>
            <p className="mt-1 text-xs text-[#57606a]">
              Open this Worker&apos;s Domains page and turn on Access for the workers.dev route.
            </p>

            <ol className="mt-4 list-decimal space-y-2 pl-5 text-xs text-[#57606a]">
              <li>Open <code>Domains</code> for <code>{workerLabel}</code>.</li>
              <li>Turn on Cloudflare Access for <code>{hubHostname}</code>.</li>
              <li>Return here and wait for the automatic reload. Sign in if prompted, then click <code>Verify</code>.</li>
            </ol>

            <div className="mt-5 flex flex-wrap gap-3">
              <a
                href={workerDomainsUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  const now = Date.now();
                  accessAutoReloadedRef.current = false;
                  setAccessWaitNow(now);
                  setAccessWaitUntil(now + ACCESS_PROPAGATION_WAIT_SECONDS * 1000);
                  setError(null);
                  setErrorHint(null);
                }}
                className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4]"
              >
                Open Domains
              </a>
            </div>

            <div className="mt-4 rounded-lg border border-[#d4a72c]/30 bg-[#fff8c5] px-3 py-2 text-xs text-[#9a6700]">
              Cloudflare Access can take about {ACCESS_PROPAGATION_WAIT_SECONDS} seconds to start sending the JWT after you turn it on.
              {accessWaitActive ? ` Tiller will reload automatically in ${accessWaitRemaining}s.` : " If you just changed it, start the timer before verifying."}
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-[#d0d7de] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#24292f]">Reload automatically, then verify</h2>
                <p className="mt-1 text-xs text-[#57606a]">
                  Wait about {ACCESS_PROPAGATION_WAIT_SECONDS} seconds after enabling Access. Tiller will reload this page, then Verify works after the page loads through Cloudflare Access.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  disabled={accessWaitActive}
                  className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-40"
                >
                  {accessWaitActive ? `Reloading in ${accessWaitRemaining}s` : "Reload now"}
                </button>
                <button
                  type="button"
                  onClick={() => void verifyWorkersDevAccess()}
                  disabled={busy || accessWaitActive}
                  className="rounded-lg border border-[#0969da] bg-white px-4 py-2 text-sm font-medium text-[#0969da] transition-colors hover:bg-[#ddf4ff] disabled:opacity-40"
                >
                  {accessWaitActive ? `Wait ${accessWaitRemaining}s` : busyAction === "verify-access" ? "Verifying..." : "Verify Access"}
                </button>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <p className="font-medium">{error}</p>
                {errorHint && <p className="mt-1 text-xs text-red-700/90">{errorHint}</p>}
              </div>
            )}
          </section>
        </main>
      </div>
    );
  }

  if (status.setupPhase === "github-app") {
    const createUrl = `${HUB_URL}/api/github/manifest/setup`;
    const installUrl = status.githubAppInstallUrl ?? `${HUB_URL}/api/github/install`;
    return (
      <div className="flex-1 overflow-y-auto bg-white">
        <main className="mx-auto w-full max-w-3xl px-6 py-8">
          <SetupSteps active="github" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#57606a]">Required setup</p>
          <h1 className="mt-2 text-2xl font-semibold text-[#24292f]">Connect GitHub</h1>
          <p className="mt-2 text-sm text-[#57606a]">
            Tiller needs a GitHub App for coding repos. Cloudflare&apos;s deploy-button GitHub connection is separate.
          </p>

          <section className="mt-6 rounded-xl border border-[#d0d7de] bg-white p-5">
            <h2 className="text-base font-semibold text-[#24292f]">Create and install the app</h2>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-xs text-[#57606a]">
              <li>Create the Tiller GitHub App in GitHub.</li>
              <li>Install it on the repositories Tiller should use, and optionally on the generated hub repo for self-updates.</li>
              <li>Return here, refresh status, then test one selected repository.</li>
            </ol>

            <div className="mt-5 flex flex-wrap gap-3">
              {!status.githubAppConfigured && (
                <a
                  href={createUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setWaitingForGitHub(true)}
                  className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4]"
                >
                  Create GitHub App
                </a>
              )}
              {status.githubAppConfigured && (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4]"
                >
                  Install on repositories
                </a>
              )}
              <button
                type="button"
                onClick={() => void onRefresh()}
                className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
              >
                Refresh status
              </button>
            </div>

            {waitingForGitHub && !status.githubAppConfigured && (
              <div className="mt-4 rounded-lg border border-[#d4a72c]/30 bg-[#fff8c5] px-3 py-2 text-xs text-[#9a6700]">
                GitHub opened in another tab. Return here after creation and refresh status.
              </div>
            )}

            {status.githubAppConfigured && (
              <div className="mt-4 rounded-lg border border-[#1a7f37]/25 bg-[#f0fff4] px-3 py-2 text-xs text-[#1a7f37]">
                GitHub App created{status.githubAppSlug ? `: ${status.githubAppSlug}` : ""}.
              </div>
            )}
          </section>

          {status.githubAppConfigured && (
            <section className="mt-4 rounded-xl border border-[#d0d7de] bg-white p-5">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid min-w-[220px] flex-1 gap-1">
                  <span className="text-xs font-medium text-[#24292f]">Repository</span>
                  <select
                    value={selectedRepoKey}
                    onChange={(event) => {
                      setSelectedRepoKey(event.target.value);
                      setGithubTest(null);
                    }}
                    disabled={busy || githubRepositories.loading}
                    className="rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30 disabled:opacity-50"
                  >
                    <option value="">
                      {githubRepositories.loading
                        ? "Loading repositories..."
                        : githubRepositories.repositories.length === 0
                          ? "No selected repositories"
                          : "Select repository"}
                    </option>
                    {githubRepositories.repositories.map((selection) => (
                      <option key={githubRepositoryKey(selection)} value={githubRepositoryKey(selection)}>
                        {selection.fullName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void testGitHubAccess()}
                  disabled={busy || githubRepositories.loading || !selectedRepo}
                  className="rounded-lg border border-[#0969da] bg-white px-4 py-2 text-sm font-medium text-[#0969da] transition-colors hover:bg-[#ddf4ff] disabled:opacity-40"
                >
                  {busyAction === "test-github" ? "Testing..." : "Test repository"}
                </button>
              </div>

              {githubRepositories.error && (
                <div className="mt-4 rounded-lg border border-[#d4a72c]/30 bg-[#fff8c5] px-3 py-2 text-sm text-[#9a6700]">
                  <p className="font-medium">{githubRepositories.error}</p>
                  <p className="mt-1 text-xs text-[#9a6700]/90">
                    Install the GitHub App on at least one repository, then refresh status.
                  </p>
                </div>
              )}

              {githubTest && (
                <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
                  githubTest.ok
                    ? "border-[#1a7f37]/25 bg-[#f0fff4] text-[#1a7f37]"
                    : "border-[#d4a72c]/30 bg-[#fff8c5] text-[#9a6700]"
                }`}>
                  <p className="font-medium">
                    {githubTest.ok ? "Repository access ready" : "Repository access needs attention"}
                  </p>
                  <p className="mt-1 text-xs">{githubTest.message}</p>
                </div>
              )}

              <div className="mt-4 rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-sm text-[#57606a]">
                <p className="font-medium text-[#24292f]">
                  Self-update repo: {status.selfUpdateRepo.status}
                </p>
                <p className="mt-1 text-xs">
                  {status.selfUpdateRepo.status === "detected"
                    ? `${status.selfUpdateRepo.fullName} on ${status.selfUpdateRepo.branch}`
                    : status.selfUpdateRepo.status === "ambiguous"
                      ? "Choose the generated hub repo from Settings after setup."
                      : "Recommended, not required. You can connect it later from Settings."}
                </p>
              </div>

              {error && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <p className="font-medium">{error}</p>
                  {errorHint && <p className="mt-1 text-xs text-red-700/90">{errorHint}</p>}
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#57606a]">Optional setup</p>
        <h1 className="mt-2 text-2xl font-semibold text-[#24292f]">Add model keys</h1>
        <p className="mt-2 text-sm text-[#57606a]">
          Kimi K2.5 runs through Cloudflare Workers AI. Add a key only if you also want Claude or Codex API access.
        </p>

        {status.workersAiConfigured && (
          <div className="mt-5 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            Kimi K2.5 is ready.
          </div>
        )}

        <section className="mt-6 rounded-xl border border-[#d0d7de] bg-[#f6f8fa] p-5">
          <div className={`grid gap-3 ${codexVisible || selfHostModelOptions ? "md:grid-cols-2" : ""}`}>
            {selfHostModelOptions && (
              <button
                type="button"
                onClick={() => setModelMode("subscription")}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  modelMode === "subscription"
                    ? "border-[#0969da] bg-[#ddf4ff]"
                    : "border-[#d0d7de] bg-white hover:border-[#0969da]/40"
                }`}
              >
                <p className="text-sm font-semibold text-[#24292f]">Claude subscription</p>
                <p className="mt-1 text-xs text-[#57606a]">For Self Host.</p>
              </button>
            )}
            <button
              type="button"
              onClick={() => setModelMode("api")}
              className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                modelMode === "api"
                  ? "border-[#0969da] bg-[#ddf4ff]"
                  : "border-[#d0d7de] bg-white hover:border-[#0969da]/40"
              }`}
            >
              <p className="text-sm font-semibold text-[#24292f]">Anthropic API key</p>
              <p className="mt-1 text-xs text-[#57606a]">For Claude.</p>
            </button>
            {codexVisible && (
              <button
                type="button"
                onClick={() => setModelMode("api-key")}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  modelMode === "api-key"
                    ? "border-[#0969da] bg-[#ddf4ff]"
                    : "border-[#d0d7de] bg-white hover:border-[#0969da]/40"
                }`}
              >
                <p className="text-sm font-semibold text-[#24292f]">OpenAI API key</p>
                <p className="mt-1 text-xs text-[#57606a]">For Codex.</p>
              </button>
            )}
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-medium text-[#24292f]">
              {modelMode === "subscription"
                ? "Claude Code OAuth token"
                : modelMode === "api"
                  ? "Anthropic API key"
                  : "OpenAI API key"}
            </span>
            <input
              type="password"
              value={modelCredential}
              onChange={(e) => setModelCredential(e.target.value)}
              placeholder="Paste key"
              disabled={busy}
              className="mt-2 w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30"
            />
          </label>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={() => void advanceModelAccess()}
              disabled={busy || !modelCredential.trim()}
              className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
            >
              {busyAction === "model" ? "Saving..." : "Save key"}
            </button>
          </div>
        </section>

        {error && <p className="mt-6 text-sm text-red-600">{error}</p>}
      </main>
    </div>
  );
}
