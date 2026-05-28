import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listGitHubAppRepositories, mintGitHubInstallationToken } = vi.hoisted(() => ({
  listGitHubAppRepositories: vi.fn(),
  mintGitHubInstallationToken: vi.fn(),
}));

vi.mock("../github/app", () => ({
  listGitHubAppRepositories,
  mintGitHubInstallationToken,
}));

import { resolveHubUpdateRepoState } from "../update/hub-repo";

function updateMarker(sourceId = "public-source") {
  return {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId,
    version: "0.2.30",
    label: "Tiller Hub v0.2.30",
    managedFiles: ["package.json", "wrangler.jsonc"],
  };
}

function contentResponse(value: unknown) {
  return new Response(JSON.stringify({
    type: "file",
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createEnv(config: Record<string, string> = {}) {
  const store = { ...config };
  const setConfig = vi.fn(async (key: string, value: string) => {
    store[key] = value;
  });

  return {
    store,
    setConfig,
    env: {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({
          getAllConfig: vi.fn(async () => store),
          setConfig,
        })),
      },
    },
  };
}

beforeEach(() => {
  listGitHubAppRepositories.mockReset();
  mintGitHubInstallationToken.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveHubUpdateRepoState", () => {
  it("auto-detects and stores a unique deploy-button hub repo", async () => {
    const { env, store } = createEnv();
    listGitHubAppRepositories.mockResolvedValue({
      repositories: [{
        installationId: 456,
        repositoryId: 123,
        fullName: "owner/tiller-hub",
        repoUrl: "https://github.com/owner/tiller-hub",
        private: true,
        defaultBranch: "main",
      }],
      warnings: [],
    });
    mintGitHubInstallationToken.mockResolvedValue({
      token: "installation-token",
      expiresAt: "2026-05-29T00:00:00.000Z",
      installationId: 456,
      repository: "owner/tiller-hub",
      permissions: { metadata: "read", contents: "write", pull_requests: "write" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => contentResponse(updateMarker("latest-source"))));

    const result = await resolveHubUpdateRepoState(env as never, { autoDetect: true });

    expect(result).toMatchObject({
      status: "detected",
      fullName: "owner/tiller-hub",
      branch: "main",
      repoId: 123,
      installationId: 456,
      detectedBy: "auto",
    });
    expect(store.HUB_UPDATE_REPO_STATUS).toBe("detected");
    expect(store.HUB_UPDATE_REPO_OWNER).toBe("owner");
    expect(store.HUB_UPDATE_REPO_REPO).toBe("tiller-hub");
  });

  it("does not rescan immediately after a missing result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
    const { env } = createEnv({
      HUB_UPDATE_REPO_STATUS: "missing",
      HUB_UPDATE_REPO_LAST_DETECTED_AT: "2026-05-28T00:00:00.000Z",
    });

    const result = await resolveHubUpdateRepoState(env as never, { autoDetect: true });

    expect(result).toEqual({
      status: "missing",
      lastDetectedAt: "2026-05-28T00:00:00.000Z",
    });
    expect(listGitHubAppRepositories).not.toHaveBeenCalled();
  });
});
