import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearUpdateCheckCache: vi.fn(),
  fetchRepoUpdateMetadata: vi.fn(),
  mintGitHubInstallationToken: vi.fn(),
  readHubUpdateRepoState: vi.fn(),
}));

vi.mock("../update/check-release", () => ({
  clearUpdateCheckCache: mocks.clearUpdateCheckCache,
}));

vi.mock("../update/hub-repo", () => ({
  fetchRepoUpdateMetadata: mocks.fetchRepoUpdateMetadata,
  readHubUpdateRepoState: mocks.readHubUpdateRepoState,
}));

vi.mock("../github/app", () => ({
  mintGitHubInstallationToken: mocks.mintGitHubInstallationToken,
}));

const { applyGitHubRepoUpdate } = await import("../update/github-repo-update");

function updateMarker(sourceId: string, version = "0.2.0") {
  return {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId,
    version,
    label: `Source ${sourceId}`,
    managedFiles: ["package.json", "wrangler.jsonc"],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function blobResponse(text: string): Response {
  return jsonResponse({
    content: Buffer.from(text, "utf8").toString("base64"),
    encoding: "base64",
  });
}

describe("applyGitHubRepoUpdate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("__TILLER_VERSION__", "0.1.1");
    mocks.readHubUpdateRepoState.mockResolvedValue({
      status: "detected",
      owner: "me",
      repo: "hub",
      fullName: "me/hub",
      label: "me/hub (main)",
      repoId: 123,
      installationId: 456,
      branch: "main",
      lastDetectedAt: "2026-05-27T00:00:00.000Z",
      detectedBy: "manual",
    });
    mocks.mintGitHubInstallationToken.mockResolvedValue({
      token: "installation-token",
      expiresAt: "2026-05-27T01:00:00.000Z",
      installationId: 456,
      repository: "me/hub",
      permissions: { metadata: "read", contents: "write", pull_requests: "write" },
    });
    mocks.fetchRepoUpdateMetadata.mockResolvedValue(updateMarker("current-source"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops development builds before reading self-update repo state", async () => {
    vi.stubGlobal("__TILLER_BUILD_CHANNEL__", "development");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(applyGitHubRepoUpdate({} as never)).resolves.toEqual({
      ok: true,
      status: "noop",
      expectedSourceId: "current-source",
    });

    expect(mocks.readHubUpdateRepoState).not.toHaveBeenCalled();
    expect(mocks.mintGitHubInstallationToken).not.toHaveBeenCalled();
    expect(mocks.fetchRepoUpdateMetadata).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.clearUpdateCheckCache).not.toHaveBeenCalled();
  });

  it("queues a same-tree commit when the repo already has latest source but the Worker is still behind", async () => {
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.endsWith("/repos/paperwing-dev/tiller-hub/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "public-head" } });
      }
      if (method === "GET" && url.endsWith("/repos/paperwing-dev/tiller-hub/git/commits/public-head")) {
        return jsonResponse({ tree: { sha: "public-tree" } });
      }
      if (method === "GET" && url.endsWith("/repos/paperwing-dev/tiller-hub/git/trees/public-tree?recursive=1")) {
        return jsonResponse({
          sha: "public-tree",
          truncated: false,
          tree: [
            { path: "tiller-update.json", type: "blob", sha: "meta-sha" },
            { path: "package.json", type: "blob", sha: "package-sha" },
            { path: "wrangler.jsonc", type: "blob", sha: "upstream-wrangler-sha" },
          ],
        });
      }
      if (method === "GET" && url.endsWith("/repos/paperwing-dev/tiller-hub/git/blobs/meta-sha")) {
        return blobResponse(JSON.stringify(updateMarker("latest-source")));
      }
      if (method === "GET" && url.endsWith("/repos/paperwing-dev/tiller-hub/git/blobs/upstream-wrangler-sha")) {
        return blobResponse('{"name":"hub"}');
      }
      if (method === "GET" && url.endsWith("/repos/me/hub/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "target-head" } });
      }
      if (method === "GET" && url.endsWith("/repos/me/hub/git/commits/target-head")) {
        return jsonResponse({ tree: { sha: "target-tree" } });
      }
      if (method === "GET" && url.endsWith("/repos/me/hub/git/trees/target-tree?recursive=1")) {
        return jsonResponse({
          sha: "target-tree",
          truncated: false,
          tree: [
            { path: "package.json", type: "blob", sha: "package-sha" },
            { path: "wrangler.jsonc", type: "blob", sha: "current-wrangler-sha" },
          ],
        });
      }
      if (method === "GET" && url.endsWith("/repos/me/hub/git/blobs/current-wrangler-sha")) {
        return blobResponse('{"name":"hub"}');
      }
      if (method === "POST" && url.endsWith("/repos/me/hub/git/blobs")) {
        return jsonResponse({ sha: "current-wrangler-sha" }, 201);
      }
      if (method === "POST" && url.endsWith("/repos/me/hub/git/commits")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          message: "Retry Tiller Hub deploy for v0.2.0",
          tree: "target-tree",
          parents: ["target-head"],
        });
        return jsonResponse({ sha: "retry-commit" }, 201);
      }
      if (method === "PATCH" && url.endsWith("/repos/me/hub/git/refs/heads/main")) {
        return jsonResponse({ object: { sha: "retry-commit" } });
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(applyGitHubRepoUpdate({} as never)).resolves.toEqual({
      ok: true,
      status: "queued",
      expectedSourceId: "latest-source",
      commitSha: "retry-commit",
    });

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/repos/me/hub/git/trees"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.clearUpdateCheckCache).toHaveBeenCalledTimes(1);
  });

  it("returns a typed repair result for expected normal-path failures", async () => {
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "temporarily unavailable" }, 503)));

    const result = await applyGitHubRepoUpdate({} as never);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("advanced_repair_required");
    expect(result.error).toContain("temporarily unavailable");
  });
});
