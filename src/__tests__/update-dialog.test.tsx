/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    root = null;
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof UpdateDialog>> = {}) {
    act(() => {
      root?.render(
        <UpdateDialog
          hubUrl="https://example.workers.dev"
          status={null}
          issue={null}
          isChecking={false}
          hasExecutionMachine={false}
          onDismiss={vi.fn()}
          onOpenSettings={vi.fn()}
          onRetryCheck={vi.fn()}
          onUpdated={vi.fn()}
          {...props}
        />,
      );
    });
    return container.textContent ?? "";
  }

  function findUpdateButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Update");
  }

  it("explains setup protection failures without blaming GitHub releases", () => {
    const text = renderDialog({
      issue: "Protect this hub with Cloudflare Access before using the API.",
      issueCode: "setup_protection_required",
    });

    expect(text).toContain("Access verification required");
    expect(text).toContain("Open Settings");
    expect(text).toContain("verify Access");
    expect(text).not.toContain("public deploy-button repo");
    expect(text).not.toContain("published GitHub release");
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

    const text = renderDialog({ status });

    expect(text).toContain("Check the GitHub account");
    expect(text).toContain("Tiller can currently see adam.");
    expect(text).toContain("Cloudflare Worker Settings");
    expect(findUpdateButton()).toBeInstanceOf(HTMLButtonElement);
    expect(text).not.toContain("Update with token");
    expect(text).not.toContain("Paste Cloudflare token");
    expect(text).not.toContain("Token settings");
    expect(text).not.toContain("Progress");
    expect(text).not.toContain("Ready to apply the latest release.");
  });

  it("keeps progress hidden before an update starts", () => {
    const text = renderDialog({ status: makeUpdateStatus() });

    expect(findUpdateButton()).toBeInstanceOf(HTMLButtonElement);
    expect(text).not.toContain("Progress");
    expect(text).not.toContain("Ready to apply the latest release.");
  });

  it("combines the update source and repository setup", () => {
    const text = renderDialog({ status: makeUpdateStatus() });

    expect(text).toContain("Update source");
    expect(text).toContain("Repository");
    expect(text).toContain("Tiller updates by committing the latest hub source");
    expect(text).toContain("adam/tiller-hub · main");
    expect(text).not.toContain("Self-update repository");
  });

  it("shows the runtime reminder when an execution machine is configured", () => {
    const machineText = renderDialog({ status: makeUpdateStatus(), hasExecutionMachine: true });
    expect(machineText).toContain("Update the Tiller CLI on your machine if needed, then run tiller host update.");

    const cloudflareText = renderDialog({ status: makeUpdateStatus(), hasExecutionMachine: false });
    expect(cloudflareText).not.toContain("run tiller host update");
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

    const text = renderDialog({ status });

    expect(text).toContain("A newer source build is available for the same version.");
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

    const text = renderDialog({ status });

    expect(text).toContain("Development build");
    expect(findUpdateButton()).toBeUndefined();
    expect(text).not.toContain("Self-update repository");
  });
});
