import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMeta } from "../../api/types";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

function repoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/paperwing-dev/tiller",
    githubInstallationId: 123,
    githubFullName: "paperwing-dev/tiller",
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
    ...overrides,
  };
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

  it("renders Session Env and MCP controls for the selected repo", async () => {
    const { default: RepoSettingsPage } = await import("../RepoSettingsPage");
    const html = renderToString(
      <RepoSettingsPage repo={repoMeta()} onDone={() => undefined} />,
    );

    expect(html).toContain("Repository Settings");
    expect(html).toContain("paperwing-dev/tiller");
    expect(html).toContain("Session Env");
    expect(html).toContain("MCP Servers");
    expect(html).toContain("Cloudflare MCP");
    expect(html).toContain("Add MCP Server");
  });
});
