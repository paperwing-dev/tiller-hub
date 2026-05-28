import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "../api";
import UpdateDialog from "../UpdateDialog";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

function makeUpdateStatus(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  const update = {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId: "source-a",
    version: "0.2.31",
    label: "Tiller Hub v0.2.31",
    managedFiles: ["package.json"],
  } satisfies UpdateCheckResult["currentUpdate"];
  return {
    updateAvailable: true,
    currentUpdate: update,
    latestUpdate: { ...update, sourceId: "source-b", version: "0.2.32", label: "Tiller Hub v0.2.32" },
    buildDiagnostics: {
      channel: "release",
      version: "0.2.31",
      workersCiCommitSha: null,
      workersCiBranch: "main",
    },
    hubRepo: {
      status: "detected",
      owner: "adam",
      repo: "tiller-hub",
      fullName: "adam/tiller-hub",
      label: "adam/tiller-hub (main)",
      repoId: 123,
      installationId: 456,
      branch: "main",
      lastDetectedAt: "2026-05-28T00:00:00.000Z",
      detectedBy: "auto",
    },
    updateMethod: "github_repo",
    releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub",
    ...overrides,
  };
}

describe("UpdateDialog", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  });

  afterEach(() => {
    (globalThis as typeof globalThis & { React?: typeof React }).React = originalReact;
  });

  it("explains setup protection failures without blaming GitHub releases", () => {
    const html = renderToString(
      <UpdateDialog
        hubUrl="https://example.workers.dev"
        status={null}
        issue="Protect this hub with Cloudflare Access before using the API."
        issueCode="setup_protection_required"
        isChecking={false}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onRetryCheck={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(html).toContain("Access verification required");
    expect(html).toContain("Open Settings");
    expect(html).toContain("verify Access");
    expect(html).not.toContain("public deploy-button repo");
    expect(html).not.toContain("published GitHub release");
  });

  it("shows visible GitHub owners when the self-update repo is missing", () => {
    const status = makeUpdateStatus({
      hubRepo: {
        status: "missing",
        lastDetectedAt: "2026-05-28T00:00:00.000Z",
        visibleGitHubOwners: ["adam"],
      },
      updateMethod: "connect_hub_repo",
    });

    const html = renderToString(
      <UpdateDialog
        hubUrl="https://example.workers.dev"
        status={status}
        issue={null}
        isChecking={false}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onRetryCheck={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(html).toContain("Check the GitHub account");
    expect(html).toContain("Tiller can currently see adam.");
    expect(html).toContain("Cloudflare Worker Settings");
    expect(html).toContain(">Update</button>");
    expect(html).not.toContain("Update with token");
    expect(html).not.toContain("Paste Cloudflare token");
    expect(html).not.toContain("Token settings");
    expect(html).not.toContain("Progress");
    expect(html).not.toContain("Ready to apply the latest release.");
  });

  it("keeps progress hidden before an update starts", () => {
    const html = renderToString(
      <UpdateDialog
        hubUrl="https://example.workers.dev"
        status={makeUpdateStatus()}
        issue={null}
        isChecking={false}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onRetryCheck={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(html).toContain(">Update</button>");
    expect(html).not.toContain("Progress");
    expect(html).not.toContain("Ready to apply the latest release.");
  });

  it("clarifies same-version source updates", () => {
    const status = makeUpdateStatus({
      currentUpdate: {
        ...makeUpdateStatus().currentUpdate,
        sourceId: "old-source",
        version: "0.2.32",
        label: "Tiller Hub v0.2.32",
      },
      latestUpdate: {
        ...makeUpdateStatus().latestUpdate,
        sourceId: "new-source",
        version: "0.2.32",
        label: "Tiller Hub v0.2.32",
      },
    });

    const html = renderToString(
      <UpdateDialog
        hubUrl="https://example.workers.dev"
        status={status}
        issue={null}
        isChecking={false}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onRetryCheck={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(html).toContain("A newer source build is available for the same version.");
  });

  it("does not show an update action for development builds", () => {
    const status = makeUpdateStatus({
      updateAvailable: false,
      latestUpdate: makeUpdateStatus().currentUpdate,
      buildDiagnostics: {
        channel: "development",
        version: "0.2.31",
        workersCiCommitSha: null,
        workersCiBranch: "main",
      },
    });

    const html = renderToString(
      <UpdateDialog
        hubUrl="https://example.workers.dev"
        status={status}
        issue={null}
        isChecking={false}
        onDismiss={vi.fn()}
        onOpenSettings={vi.fn()}
        onRetryCheck={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(html).toContain("Development build");
    expect(html).not.toContain(">Update</button>");
    expect(html).not.toContain("Self-update repository");
  });
});
