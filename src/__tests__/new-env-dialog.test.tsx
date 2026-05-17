import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepositorySelection } from "../api";

const useGitHubRepositoriesMock = vi.hoisted(() => vi.fn());

vi.mock("../useGitHubRepositories", () => ({
  githubRepositoryKey: (selection: { installationId: number; repositoryId: number }) =>
    `${selection.installationId}:${selection.repositoryId}`,
  useGitHubRepositories: useGitHubRepositoriesMock,
}));

import {
  getEffectiveCodexAuthPreference,
  getHarnessCredentialError,
  getInitialEnvBackendSelection,
  getRepositoryPagination,
  NewEnvDialog,
  NewRepoDialog,
  REPOSITORY_PAGE_SIZE,
} from "../NewEnvDialog";

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

function makeGitHubRepository(index: number): GitHubRepositorySelection {
  const name = `repo-${String(index).padStart(2, "0")}`;
  return {
    repositoryId: index,
    installationId: 7,
    fullName: `owner/${name}`,
    repoUrl: `https://github.com/owner/${name}`,
    private: false,
    defaultBranch: "main",
  };
}

function stripReactMarkers(markup: string): string {
  return markup.replaceAll("<!-- -->", "");
}

describe("getInitialEnvBackendSelection", () => {
  it("defaults to host when local development is pinned to the host backend", () => {
    expect(getInitialEnvBackendSelection({ isLocalDev: true, deploymentMode: "hosted", hostConnected: false })).toBe("host");
  });

  it("defaults to host when Tiller Self Host mode has a connected machine", () => {
    expect(getInitialEnvBackendSelection({ isLocalDev: false, deploymentMode: "self-host", hostConnected: true })).toBe("host");
  });

  it("defaults to cloudflare in Hosted Tiller even if a stale host is connected", () => {
    expect(getInitialEnvBackendSelection({ isLocalDev: false, deploymentMode: "hosted", hostConnected: true })).toBe("cf");
  });
});

describe("getEffectiveCodexAuthPreference", () => {
  it("keeps auto auth for host-backed Codex envs", () => {
    expect(
      getEffectiveCodexAuthPreference({
        backend: "host",
        deploymentMode: "self-host",
      }),
    ).toBe("auto");
  });

  it("forces API key auth for Hosted Tiller Cloudflare Codex envs", () => {
    expect(
      getEffectiveCodexAuthPreference({
        backend: "cf",
        deploymentMode: "hosted",
      }),
    ).toBe("api-key");
  });

  it("uses auto auth for self-host Cloudflare Codex envs", () => {
    expect(
      getEffectiveCodexAuthPreference({
        backend: "cf",
        deploymentMode: "self-host",
      }),
    ).toBe("auto");
  });
});

describe("getHarnessCredentialError", () => {
  it("blocks Claude Cloudflare envs without an Anthropic API key", () => {
    expect(
      getHarnessCredentialError({
        harness: "claude-code",
        backend: "cf",
        deploymentMode: "hosted",
      }),
    ).toContain("ANTHROPIC_API_KEY");
  });

  it("allows host Claude envs with either subscription or API key auth", () => {
    expect(
      getHarnessCredentialError({
        harness: "claude-code",
        backend: "host",
        deploymentMode: "self-host",
        hasClaudeSubscription: true,
      }),
    ).toBeNull();
    expect(
      getHarnessCredentialError({
        harness: "claude-code",
        backend: "host",
        deploymentMode: "self-host",
        hasAnthropicKey: true,
      }),
    ).toBeNull();
  });

  it("blocks Codex envs without subscription login or API key auth", () => {
    expect(
      getHarnessCredentialError({
        harness: "codex",
        backend: "host",
        deploymentMode: "self-host",
      }),
    ).toContain("OPENAI_API_KEY");
  });
});

describe("getRepositoryPagination", () => {
  it("clamps pages and reports the displayed item range", () => {
    expect(getRepositoryPagination(26, 99)).toEqual({
      page: 6,
      totalPages: 6,
      startIndex: 25,
      endIndex: 26,
      hasPrevious: true,
      hasNext: false,
    });
    expect(getRepositoryPagination(0, 3)).toEqual({
      page: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      hasPrevious: false,
      hasNext: false,
    });
  });
});

describe("NewRepoDialog", () => {
  beforeEach(() => {
    useGitHubRepositoriesMock.mockReturnValue({
      repositories: [],
      warnings: [],
      repositorySelection: "unknown",
      loading: false,
      error: null,
    });
  });

  it("renders only the first page of selected repositories with pagination controls", () => {
    useGitHubRepositoriesMock.mockReturnValue({
      repositories: Array.from({ length: REPOSITORY_PAGE_SIZE + 1 }, (_, index) => makeGitHubRepository(index + 1)),
      warnings: [],
      repositorySelection: "selected",
      loading: false,
      error: null,
    });

    const markup = stripReactMarkers(
      renderToStaticMarkup(
        <NewRepoDialog
          onClose={vi.fn()}
          hubUrl="https://hub.example.com"
          repos={[]}
          onCreate={vi.fn(async () => undefined)}
        />,
      ),
    );

    expect(markup).toContain("owner/repo-01");
    expect(markup).toContain("owner/repo-05");
    expect(markup).not.toContain("owner/repo-06");
    expect(markup).toContain("1-5 of 6");
    expect(markup).toContain("Page 1 of 2");
    expect(markup).toContain("Previous");
    expect(markup).toContain("Next");
  });

  it("hides pagination controls when the filtered repository list fits on one page", () => {
    useGitHubRepositoriesMock.mockReturnValue({
      repositories: Array.from({ length: REPOSITORY_PAGE_SIZE }, (_, index) => makeGitHubRepository(index + 1)),
      warnings: [],
      repositorySelection: "selected",
      loading: false,
      error: null,
    });

    const markup = stripReactMarkers(
      renderToStaticMarkup(
        <NewRepoDialog
          onClose={vi.fn()}
          hubUrl="https://hub.example.com"
          repos={[]}
          onCreate={vi.fn(async () => undefined)}
        />,
      ),
    );

    expect(markup).not.toContain("Page 1 of 1");
    expect(markup).not.toContain("1-5 of 5");
  });
});

describe("NewEnvDialog", () => {
  it("does not let a default Codex harness silently flip backend selection to host", () => {
    const markup = renderToStaticMarkup(
      <NewEnvDialog
        onClose={vi.fn()}
        isLocalDev={false}
        deploymentMode="self-host"
        hostConnected={false}
        hasOpenAIKey={true}
        enabledHarnesses={["codex", "claude-code", "opencode"]}
        repo={repo}
        onCreate={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).toContain('<option value="cf" selected="">Cloudflare Containers</option>');
    expect(markup).toContain('<option value="host" disabled="">Tiller Self Host</option>');
    expect(markup).toContain("Start `tiller host` to use Tiller Self Host.");
  });

  it("hides the Codex auth selector for host-backed Codex envs when auth is configured", () => {
    const markup = renderToStaticMarkup(
      <NewEnvDialog
        onClose={vi.fn()}
        isLocalDev={false}
        deploymentMode="self-host"
        hostConnected={true}
        hasOpenAIKey={true}
        enabledHarnesses={["codex", "claude-code", "opencode"]}
        repo={repo}
        onCreate={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).not.toContain("Codex Auth");
    expect(markup).not.toContain("choose auth automatically");
  });

  it("hides the Codex auth selector in Hosted Tiller when API key auth is configured", () => {
    const markup = renderToStaticMarkup(
      <NewEnvDialog
        onClose={vi.fn()}
        isLocalDev={false}
        deploymentMode="hosted"
        hostConnected={false}
        hasOpenAIKey={true}
        enabledHarnesses={["codex", "claude-code", "opencode"]}
        repo={repo}
        onCreate={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).not.toContain("Codex Auth");
    expect(markup).not.toContain("Hosted Tiller uses OPENAI_API_KEY");
  });

  it("shows a blocking credential error without disabling harness selection", () => {
    const markup = renderToStaticMarkup(
      <NewEnvDialog
        onClose={vi.fn()}
        isLocalDev={false}
        deploymentMode="hosted"
        hostConnected={false}
        enabledHarnesses={["codex", "claude-code", "opencode"]}
        repo={repo}
        onCreate={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).toContain("Codex requires OPENAI_API_KEY");
    expect(markup).toContain('<select class="w-full bg-white border border-[#d0d7de]');
    expect(markup).toContain('type="submit" disabled=""');
  });
});
