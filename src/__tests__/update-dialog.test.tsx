import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UpdateDialog from "../UpdateDialog";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

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
});
