import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import type { SetupStatus } from "./api";

const HUB_URL = window.location.origin;

interface SetupWizardProps {
  status: SetupStatus;
  onRefresh: () => Promise<void>;
}

export default function SetupWizard({ status, onRefresh }: SetupWizardProps) {
  if (status.setupPhase !== "github-app") return null;

  const createUrl = `${HUB_URL}/api/github/manifest/setup`;
  const installUrl = status.githubAppInstallUrl ?? `${HUB_URL}/api/github/install`;
  return (
    <div className="flex-1 overflow-y-auto bg-kumo-base">
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-kumo-subtle">Required setup</p>
        <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">Connect GitHub</h1>
        <p className="mt-2 text-sm text-kumo-subtle">
          Give this Tiller instance access to at least one repository before opening the dashboard.
        </p>

        <section className="mt-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
          {!status.githubAppConfigured ? (
            <>
              <h2 className="text-base font-semibold text-kumo-strong">One guided connection</h2>
              <p className="mt-2 text-sm leading-6 text-kumo-subtle">
                GitHub will create the private App, let you choose its repositories, and return here when it is ready.
              </p>
              <div className="mt-5">
                <LinkButton href={createUrl} variant="primary">
                  Connect GitHub
                </LinkButton>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-kumo-strong">Finish connecting GitHub</h2>
              <p className="mt-2 text-sm leading-6 text-kumo-subtle">
                GitHub App created{status.githubAppSlug ? `: ${status.githubAppSlug}` : ""}. Tiller is waiting for an installation with the requested permissions and at least one repository.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <LinkButton href={installUrl} variant="primary">
                  Continue on GitHub
                </LinkButton>
                <Button variant="secondary" onClick={() => void onRefresh()}>
                  Check again
                </Button>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
