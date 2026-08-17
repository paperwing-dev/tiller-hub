/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "../api";
import UpdateDialog from "../UpdateDialog";

afterEach(cleanup);

function status(kind: UpdateCheckResult["kind"]): UpdateCheckResult {
  return {
    kind,
    currentRelease: {
      schemaVersion: 1,
      channel: "release",
      hubVersion: "0.2.54",
      releaseId: "a".repeat(40),
    },
    stableRelease: {
      releaseId: "b".repeat(40),
      version: "0.2.55",
      releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v0.2.55",
    },
    updateAvailable: true,
    buildDiagnostics: { channel: "release", version: "0.2.54", workersCiCommitSha: null, workersCiBranch: null },
    errors: [],
  };
}

function renderDialog(updateStatus: UpdateCheckResult) {
  const onCheckNow = vi.fn();
  render(<UpdateDialog
    hubUrl="https://hub.example"
    status={updateStatus}
    issue={null}
    issueCode={null}
    isChecking={false}
    hasExecutionMachine={false}
    onDismiss={vi.fn()}
    onIgnore={vi.fn()}
    onOpenSettings={vi.fn()}
    onCheckNow={onCheckNow}
  />);
  return { onCheckNow };
}

describe("update dialog", () => {
  it("offers installer maintenance only to managed Hubs", () => {
    const { onCheckNow } = renderDialog(status("installer-managed"));
    expect(screen.getAllByText("Update to v0.2.55").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(onCheckNow).toHaveBeenCalledOnce();
    expect(screen.queryByText("Clean reinstall")).toBeNull();
  });

  it("gives unmanaged Hubs a clean-reinstall link and no repository controls", () => {
    renderDialog(status("unmanaged"));
    const link = screen.getByText("Clean reinstall").closest("a");
    expect(link?.getAttribute("href")).toBe("https://install.paperwing.dev/deploy");
    expect(document.body.textContent).not.toContain("Check GitHub repos");
    expect(document.body.textContent).not.toContain("Cloudflare API token");
  });

  it("renders stable lookup errors without an in-place repair action", () => {
    renderDialog({
      ...status("unmanaged"),
      stableRelease: null,
      updateAvailable: false,
      errors: [{ code: "stable_release_unavailable", message: "stable unavailable", retryable: true }],
    });
    expect(screen.getByText("stable unavailable")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Repair");
  });
});
