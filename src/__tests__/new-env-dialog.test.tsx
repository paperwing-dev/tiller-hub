import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getInitialEnvBackendSelection, NewEnvDialog } from "../NewEnvDialog";

const repo = {
  repoId: "repo-1",
  repoUrl: "https://github.com/example/repo",
  mainCommit: "main-sha",
  gitArtifactId: "git-artifact-1",
  gitStatus: "ready" as const,
  createdAt: "2026-04-13T00:00:00.000Z",
  updatedAt: "2026-04-13T00:00:00.000Z",
  bootstrappedFromRef: "HEAD",
};

describe("getInitialEnvBackendSelection", () => {
  it("defaults to host when local development is pinned to the host backend", () => {
    expect(getInitialEnvBackendSelection({ isLocalDev: true, hostConnected: false })).toBe("host");
  });

  it("defaults to host when a Tiller Host is currently connected", () => {
    expect(getInitialEnvBackendSelection({ isLocalDev: false, hostConnected: true })).toBe("host");
  });

  it("defaults to cloudflare when no host is currently connected", () => {
    expect(getInitialEnvBackendSelection({ isLocalDev: false, hostConnected: false })).toBe("cf");
  });
});

describe("NewEnvDialog", () => {
  it("does not let a default Codex harness silently flip backend selection to host", () => {
    const markup = renderToStaticMarkup(
      <NewEnvDialog
        onClose={vi.fn()}
        isLocalDev={false}
        hostConnected={false}
        enabledHarnesses={["codex", "claude-code", "opencode"]}
        repo={repo}
        onCreate={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).toContain('<option value="cf" selected="">Cloudflare Containers</option>');
    expect(markup).toContain('<option value="host">Tiller Host</option>');
  });
});
