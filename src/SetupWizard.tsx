import { useEffect, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Select } from "@cloudflare/kumo/components/select";
import { useToast } from "./Toast";
import type { GitHubAccessTestResult, SetupStatus } from "./api";
import { testGitHubAppAccess } from "./api";
import { githubRepositoryKey, useGitHubRepositories } from "./useGitHubRepositories";

const HUB_URL = window.location.origin;

interface SetupWizardProps {
  status: SetupStatus;
  onRefresh: () => Promise<void>;
}

export default function SetupWizard({ status, onRefresh }: SetupWizardProps) {
  const [busy, setBusy] = useState(false);
  const [waitingForGitHub, setWaitingForGitHub] = useState(false);
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
  const [githubTest, setGithubTest] = useState<GitHubAccessTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToast();
  const githubRepositories = useGitHubRepositories(HUB_URL, {
    enabled: status.setupPhase === "github-app" && status.githubAppConfigured && !status.githubAppPublicHubDisabled,
  });
  const selectedRepo = githubRepositories.repositories.find(
    (selection) => githubRepositoryKey(selection) === selectedRepoKey,
  ) ?? null;

  useEffect(() => {
    if (!githubRepositories.repositories.length) {
      setSelectedRepoKey("");
      return;
    }
    setSelectedRepoKey((current) => (
      githubRepositories.repositories.some((selection) => githubRepositoryKey(selection) === current)
        ? current
        : githubRepositoryKey(githubRepositories.repositories[0])
    ));
  }, [githubRepositories.repositories]);

  useEffect(() => {
    const refresh = () => void onRefresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [onRefresh]);

  async function testGitHubAccess() {
    if (!selectedRepo) return;
    setBusy(true);
    setError(null);
    setGithubTest(null);
    try {
      const result = await testGitHubAppAccess(HUB_URL, selectedRepo);
      setGithubTest(result);
      if (result.ok) {
        await onRefresh();
        addToast({
          title: "GitHub ready",
          body: `Tiller can use ${result.repo ?? selectedRepo.fullName}.`,
          variant: "success",
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub access check failed.");
    } finally {
      setBusy(false);
    }
  }

  if (status.setupPhase !== "github-app") return null;

  const createUrl = `${HUB_URL}/api/github/manifest/setup`;
  const installUrl = status.githubAppInstallUrl ?? `${HUB_URL}/api/github/install`;
  return (
    <div className="flex-1 overflow-y-auto bg-kumo-base">
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-kumo-subtle">Required setup</p>
        <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">Connect GitHub</h1>
        <p className="mt-2 text-sm text-kumo-subtle">
          Create the Tiller GitHub App, grant its requested permissions, and install it on at least one repository before opening the dashboard.
        </p>

        <section className="mt-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
          <h2 className="text-base font-semibold text-kumo-strong">Create and install the app</h2>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-xs text-kumo-subtle">
            <li>Create the Tiller GitHub App with the prefilled manifest.</li>
            <li>Install it on one or more repositories Tiller should use.</li>
            <li>Return here and verify one repository.</li>
          </ol>

          <div className="mt-5 flex flex-wrap gap-3">
            {!status.githubAppConfigured ? (
              <LinkButton href={createUrl} external variant="primary" onClick={() => setWaitingForGitHub(true)}>
                Create GitHub App
              </LinkButton>
            ) : (
              <LinkButton href={installUrl} external variant="primary">
                Install on repositories
              </LinkButton>
            )}
            <Button variant="secondary" onClick={() => void onRefresh()}>
              Refresh status
            </Button>
          </div>

          {waitingForGitHub && !status.githubAppConfigured && (
            <p className="mt-4 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2 text-xs text-kumo-warning">
              GitHub opened in another tab and will return to this Hub after creation.
            </p>
          )}
          {status.githubAppConfigured && (
            <p className="mt-4 rounded-lg border border-kumo-success/25 bg-kumo-success-tint px-3 py-2 text-xs text-kumo-success">
              GitHub App created{status.githubAppSlug ? `: ${status.githubAppSlug}` : ""}.
            </p>
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
                placeholder={githubRepositories.loading ? "Loading repositories..." : "Select repository"}
                items={githubRepositories.repositories.map((selection) => ({
                  label: selection.fullName,
                  value: githubRepositoryKey(selection),
                }))}
              />
              <Button
                variant="primary"
                onClick={() => void testGitHubAccess()}
                disabled={busy || githubRepositories.loading || !selectedRepo}
                loading={busy}
              >
                {busy ? "Testing..." : "Verify repository"}
              </Button>
            </div>

            {(githubRepositories.error || error) && (
              <p className="mt-4 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-warning">
                {error ?? githubRepositories.error}
              </p>
            )}
            {!githubRepositories.loading && githubRepositories.repositories.length === 0 && !githubRepositories.error && (
              <p className="mt-4 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-warning">
                No usable repository is installed. Install the App on at least one repository with the requested permissions.
              </p>
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
          </section>
        )}
      </main>
    </div>
  );
}
