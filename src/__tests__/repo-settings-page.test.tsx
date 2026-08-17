import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMeta } from "../../api/types";
import { createInitialRepoScmState } from "../../api/scm/model";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

function repoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-01-01T00:00:00.000Z";
  const repo: RepoMeta = {
    repoId: "repo-1",
    artifactStoreGeneration: null,
    repoUrl: "https://github.com/example/private-repo",
    githubInstallationId: 123,
    githubFullName: "example/private-repo",
    ...createInitialRepoScmState(),
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "abc123",
    githubWebhookConfigured: true,
    mainCommit: "abc123",
    gitArtifactId: "git-1",
    gitStatus: "ready",
    gitError: null,
    gitFormatVersion: 1,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
    createdAt: now,
    updatedAt: now,
    bootstrappedFromRef: null,
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
    githubPublish: null,
  };
  return Object.assign(repo, overrides);
}

describe("RepoSettingsPage", () => {
  const originalWindow = globalThis.window;
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://hub.example.com" },
      },
    });
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
    vi.resetModules();
  });

  it("renders task variables and MCP controls for the selected repo", async () => {
    const { default: RepoSettingsPage } = await import("../RepoSettingsPage");
    const html = renderToString(
      <RepoSettingsPage
        repo={repoMeta()}
        onDone={() => undefined}
        implementationCount={2}
        onRemoveProject={async () => undefined}
      />,
    );

    expect(html).toContain("Repository Settings");
    expect(html).toContain("example/private-repo");
    expect(html).toContain("Task variables");
    expect(html).not.toContain("Cloudflare MCP");
    expect(html).not.toContain("Unavailable");
    expect(html).toContain("MCP servers");
    expect(html).not.toContain("Cloudflare Docs");
    expect(html).toContain("Add MCP Server");
    expect(html).toContain("Remove project");
    expect(html).toContain("The GitHub repository is not deleted.");
    expect(html).toContain(
      "For now, Tiller supports only public HTTPS MCP servers that don&#x27;t require authentication.",
    );
  });
});
