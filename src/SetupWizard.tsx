import { useEffect, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useToast } from "./Toast";
import type { GitHubAccessTestResult, SetupStatus } from "./api";
import { detectSelfUpdateRepo, startWorkersDevAccessOAuth, submitSetup, testGitHubAppAccess } from "./api";
import { githubRepositoryKey, useGitHubRepositories } from "./useGitHubRepositories";
import { KIMI_K2_7_CODE } from "../shared/harness-catalog";

const HUB_URL = window.location.origin;
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
                ? "border-kumo-success/25 bg-kumo-success-tint"
                : current
                  ? "border-kumo-info/40 bg-kumo-info-tint"
                  : "border-kumo-line bg-kumo-base"
            }`}
          >
            <p className="text-xs font-semibold text-kumo-default">Step {index + 1} of 2</p>
            <p className="mt-1 text-sm font-medium text-kumo-default">{step.label}</p>
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
  const [busyAction, setBusyAction] = useState<"model" | "connect-access" | "test-github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [waitingForGitHub, setWaitingForGitHub] = useState(false);
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
  const [githubTest, setGithubTest] = useState<GitHubAccessTestResult | null>(null);
  const busy = busyAction !== null;
  const githubRepositories = useGitHubRepositories(HUB_URL, {
    enabled: status.setupPhase === "github-app" && status.githubAppConfigured && !status.githubAppPublicHubDisabled,
  });
  const selectedRepo = githubRepositories.repositories.find(
    (selection) => githubRepositoryKey(selection) === selectedRepoKey,
  ) ?? null;
  const selfHostModelOptions = status.isLocalDev;
  const [modelMode, setModelMode] = useState<ModelAuthMode>("api");
  const [modelCredential, setModelCredential] = useState("");
  const addToast = useToast();
  const openAiApiKeyVisible =
    status.enabledHarnesses.includes("codex")
    || status.enabledHarnesses.includes("opencode")
    || status.hasOpenAIKey
    || status.hasChatGPTAuth;

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
        body: "Model access is saved. Open Settings to choose an execution backend.",
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

  async function connectWorkersDevAccess() {
    setBusyAction("connect-access");
    setError(null);
    setErrorHint(null);
    try {
      const job = await startWorkersDevAccessOAuth(HUB_URL);
      window.location.assign(job.connectUrl);
    } catch (err) {
      setBusyAction(null);
      setError(err instanceof Error ? err.message : "Cloudflare connection could not start.");
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
    const hubHostname = new URL(status.workersDevHubUrl!).hostname;
    return (
      <div className="flex-1 overflow-y-auto bg-kumo-base">
        <main className="mx-auto w-full max-w-3xl px-6 py-8">
          <SetupSteps active="access" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-kumo-subtle">Required setup</p>
          <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">Connect Cloudflare and protect Tiller</h1>
          <p className="mt-2 text-sm text-kumo-subtle">
            Tiller uses Cloudflare OAuth to verify the owner and configure the narrow Access boundary for this Hub.
          </p>

          <section className="mt-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">Exact workers.dev hostname</p>
            <code className="mt-2 block break-all rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default">
              {hubHostname}
            </code>

            <h2 className="mt-5 text-base font-semibold text-kumo-strong">Two Access applications</h2>
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
                <p className="text-sm font-semibold text-kumo-default">Tiller callbacks</p>
                <p className="mt-1 text-xs text-kumo-subtle">
                  Three reserved callback paths on <code>{hubHostname}</code>. Tiller accepts only the exact authenticated endpoints below:
                </p>
                <ul className="mt-2 grid gap-1 text-xs text-kumo-subtle">
                  <li><code>/api/github/webhook</code></li>
                  <li><code>/api/setup/workers-dev-access/broker/proof</code></li>
                  <li><code>/api/setup/workers-dev-access/broker/complete</code></li>
                </ul>
              </div>
              <div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
                <p className="text-sm font-semibold text-kumo-default">Tiller Hub</p>
                <p className="mt-1 text-xs text-kumo-subtle">
                  The exact host <code>{hubHostname}</code>, limited to the OAuth owner and the Tiller service token.
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
              <p className="text-sm font-semibold text-kumo-default">Owner sign-in</p>
              <p className="mt-1 text-xs text-kumo-subtle">
                Tiller reuses a Cloudflare identity provider restricted to account members. If this account does not have one,
                Tiller creates <code>Tiller owner sign-in</code> and attaches it only to Tiller Hub. Existing identity providers
                and defaults are not changed.
              </p>
            </div>

            <div className="mt-5">
              <Button
                variant="primary"
                onClick={() => void connectWorkersDevAccess()}
                disabled={busy}
                loading={busyAction === "connect-access"}
              >
                {busyAction === "connect-access" ? "Opening Cloudflare..." : "Connect Cloudflare and protect Tiller"}
              </Button>
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
                <p className="font-medium">{error}</p>
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
      <div className="flex-1 overflow-y-auto bg-kumo-base">
        <main className="mx-auto w-full max-w-3xl px-6 py-8">
          <SetupSteps active="github" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-kumo-subtle">Required setup</p>
          <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">Connect GitHub</h1>
          <p className="mt-2 text-sm text-kumo-subtle">
            Tiller needs a GitHub App for coding repos. Cloudflare&apos;s deploy-button GitHub connection is separate.
          </p>

          <section className="mt-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
            <h2 className="text-base font-semibold text-kumo-strong">Create and install the app</h2>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-xs text-kumo-subtle">
              <li>Create the Tiller GitHub App in GitHub.</li>
              <li>Install it on the repositories Tiller should use, and optionally on the generated hub repo for self-updates.</li>
              <li>GitHub returns to Tiller automatically. Test one selected repository after installation.</li>
            </ol>

            <div className="mt-5 flex flex-wrap gap-3">
              {!status.githubAppConfigured && (
                <LinkButton
                  href={createUrl}
                  external
                  variant="primary"
                  onClick={() => setWaitingForGitHub(true)}
                >
                  Create GitHub App
                </LinkButton>
              )}
              {status.githubAppConfigured && (
                <LinkButton href={installUrl} external variant="primary">
                  Install on repositories
                </LinkButton>
              )}
              <Button variant="secondary" onClick={() => void onRefresh()}>
                Refresh status
              </Button>
            </div>

            {waitingForGitHub && !status.githubAppConfigured && (
              <div className="mt-4 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2 text-xs text-kumo-warning">
                GitHub opened in another tab. That tab returns to Tiller automatically after creation.
              </div>
            )}

            {status.githubAppConfigured && (
              <div className="mt-4 rounded-lg border border-kumo-success/25 bg-kumo-success-tint px-3 py-2 text-xs text-kumo-success">
                GitHub App created{status.githubAppSlug ? `: ${status.githubAppSlug}` : ""}.
              </div>
            )}
          </section>

          {status.githubAppConfigured && (
            <section className="mt-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="flex flex-wrap items-end gap-3">
                <Select
                  label="Repository"
                  className="min-w-[220px] flex-1"
                  value={selectedRepoKey || null}
                  onValueChange={(value) => {
                    setSelectedRepoKey(value ?? "");
                    setGithubTest(null);
                  }}
                  disabled={busy || githubRepositories.loading}
                  loading={githubRepositories.loading}
                  placeholder={
                    githubRepositories.loading
                      ? "Loading repositories..."
                      : githubRepositories.repositories.length === 0
                        ? "No selected repositories"
                        : "Select repository"
                  }
                  items={githubRepositories.repositories.map((selection) => ({
                    label: selection.fullName,
                    value: githubRepositoryKey(selection),
                  }))}
                />
                <Button
                  variant="primary"
                  onClick={() => void testGitHubAccess()}
                  disabled={busy || githubRepositories.loading || !selectedRepo}
                  loading={busyAction === "test-github"}
                >
                  {busyAction === "test-github" ? "Testing..." : "Test repository"}
                </Button>
              </div>

              {githubRepositories.error && (
                <div className="mt-4 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-warning">
                  <p className="font-medium">{githubRepositories.error}</p>
                  <p className="mt-1 text-xs text-kumo-warning/90">
                    After the issue above is resolved, refresh status.
                  </p>
                </div>
              )}

              {githubTest && (
                <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
                  githubTest.ok
                    ? "border-kumo-success/25 bg-kumo-success-tint text-kumo-success"
                    : "border-kumo-warning/30 bg-kumo-warning-tint text-kumo-warning"
                }`}>
                  <p className="font-medium">
                    {githubTest.ok ? "Repository access ready" : "Repository access needs attention"}
                  </p>
                  <p className="mt-1 text-xs">{githubTest.message}</p>
                </div>
              )}

              <div className="mt-4 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
                <p className="font-medium text-kumo-default">
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
                <div className="mt-4 rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
                  <p className="font-medium">{error}</p>
                  {errorHint && <p className="mt-1 text-xs text-kumo-danger/90">{errorHint}</p>}
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-kumo-base">
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-kumo-subtle">Optional setup</p>
        <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">Add model keys</h1>
        <p className="mt-2 text-sm text-kumo-subtle">
          {KIMI_K2_7_CODE.label} runs through Cloudflare Workers AI. Add a key for Claude, Codex, or OpenAI-backed OpenCode models.
        </p>

        {status.workersAiConfigured && (
          <div className="mt-5 rounded-lg border border-kumo-success/25 bg-kumo-success-tint px-3 py-2 text-sm text-kumo-success">
            {KIMI_K2_7_CODE.label} is ready.
          </div>
        )}

        <section className="mt-6 rounded-xl border border-kumo-line bg-kumo-recessed p-5">
          <div className={`grid gap-3 ${openAiApiKeyVisible || selfHostModelOptions ? "md:grid-cols-2" : ""}`}>
            {selfHostModelOptions && (
              <button
                type="button"
                onClick={() => setModelMode("subscription")}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  modelMode === "subscription"
                    ? "border-kumo-focus bg-kumo-info-tint"
                    : "border-kumo-line bg-kumo-base hover:border-kumo-focus/40"
                }`}
              >
                <p className="text-sm font-semibold text-kumo-default">Claude subscription</p>
                <p className="mt-1 text-xs text-kumo-subtle">For workloads on Your machine.</p>
              </button>
            )}
            <button
              type="button"
              onClick={() => setModelMode("api")}
              className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                modelMode === "api"
                  ? "border-kumo-focus bg-kumo-info-tint"
                  : "border-kumo-line bg-kumo-base hover:border-kumo-focus/40"
              }`}
            >
              <p className="text-sm font-semibold text-kumo-default">Anthropic API key</p>
              <p className="mt-1 text-xs text-kumo-subtle">For Claude.</p>
            </button>
            {openAiApiKeyVisible && (
              <button
                type="button"
                onClick={() => setModelMode("api-key")}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  modelMode === "api-key"
                    ? "border-kumo-focus bg-kumo-info-tint"
                    : "border-kumo-line bg-kumo-base hover:border-kumo-focus/40"
                }`}
              >
                <p className="text-sm font-semibold text-kumo-default">OpenAI API key</p>
                <p className="mt-1 text-xs text-kumo-subtle">For Codex and OpenAI-backed OpenCode models.</p>
              </button>
            )}
          </div>

          <div className="mt-5">
            <Input
              type="password"
              label={
                modelMode === "subscription"
                  ? "Claude Code OAuth token"
                  : modelMode === "api"
                    ? "Anthropic API key"
                    : "OpenAI API key"
              }
              value={modelCredential}
              onChange={(e) => setModelCredential(e.target.value)}
              placeholder="Paste key"
              disabled={busy}
            />
          </div>

          <div className="mt-5 flex justify-end">
            <Button
              variant="primary"
              onClick={() => void advanceModelAccess()}
              disabled={busy || !modelCredential.trim()}
              loading={busyAction === "model"}
            >
              {busyAction === "model" ? "Saving..." : "Save key"}
            </Button>
          </div>
        </section>

        {error && <p className="mt-6 text-sm text-kumo-danger">{error}</p>}
      </main>
    </div>
  );
}
