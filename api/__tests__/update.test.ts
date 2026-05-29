import { afterEach, describe, expect, it, vi } from "vitest";
const { resolveWorkerServiceNameMock, resolveAccountForHostnameMock } = vi.hoisted(() => ({
  resolveWorkerServiceNameMock: vi.fn(async () => "tiller-hub"),
  resolveAccountForHostnameMock: vi.fn(),
}));

vi.mock("../setup/cloudflare", () => ({
  resolveWorkerServiceName: resolveWorkerServiceNameMock,
}));

vi.mock("../access/cloudflare-api", () => ({
  resolveAccountForHostname: resolveAccountForHostnameMock,
}));

import { checkForUpdate, compareVersions } from "../update/check-release";
import {
  buildKnownContainerNames,
  buildTillerBindings,
  ensureTillerResources,
  findDurableObjectBindingNameForClass,
  reconcileContainerApplication,
  resolveAccountAndScript,
} from "../update/cloudflare-deploy";
import { parseTillerUpdateMetadata } from "../update/metadata";
import type { UpdateManifest } from "../update/types";

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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function latestReleaseResponse(version = "0.2.0"): Response {
  return jsonResponse({
    tag_name: `tiller-hub-v${version}`,
    html_url: `https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v${version}`,
    assets: [],
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function mockLatestReleaseFetch(latestUpdate = updateMarker("latest-source")) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith("/repos/paperwing-dev/tiller-hub/releases/latest")) {
      return latestReleaseResponse(latestUpdate.version);
    }
    if (url.endsWith(`/paperwing-dev/tiller-hub/tiller-hub-v${latestUpdate.version}/tiller-update.json`)) {
      return jsonResponse(latestUpdate);
    }
    return jsonResponse({ message: "Not Found" }, 404);
  });
}

const manifest: UpdateManifest = {
  version: "0.2.0",
  compatibility_date: "2025-01-29",
  compatibility_flags: ["nodejs_compat"],
  migrations: [],
  bindings: [
    { type: "durable_object_namespace", name: "HUB", class_name: "HubDO" },
    { type: "kv_namespace", name: "ENVS_KV", title_suffix: "envs-kv" },
    { type: "r2_bucket", name: "BUCKET", name_derive: "worker" },
    { type: "ai", name: "AI" },
    { type: "assets", name: "ASSETS" },
    { type: "worker_loader", name: "LOADER" },
    { type: "plain_text", name: "ENABLED_ENV_HARNESSES", text: "claude-code,codex" },
  ],
  containers: [
    {
      class_name: "SandboxDO",
      app_name_suffix: "sandboxdo",
      image: "docker.io/jamieatlason/tiller-sandbox:v2",
      max_instances: 2,
      instance_type: "basic",
    },
    {
      class_name: "ScmBootstrapDO",
      app_name_suffix: "scmbootstrapdo",
      image: "docker.io/jamieatlason/tiller-scm:v2",
      max_instances: 2,
      instance_type: "basic",
    },
    {
      class_name: "ScmOperationDO",
      app_name_suffix: "scmoperationdo",
      image: "docker.io/jamieatlason/tiller-scm:v2",
      max_instances: 2,
      instance_type: "basic",
    },
  ],
};

describe("compareVersions", () => {
  it("treats tiller release tags as semver values", () => {
    expect(compareVersions("0.1.0", "tiller-hub-v0.2.0")).toBeLessThan(0);
    expect(compareVersions("tiller-hub-v0.2.0", "v0.2.0")).toBe(0);
    expect(compareVersions("0.3.0", "0.2.9")).toBeGreaterThan(0);
  });
});

describe("parseTillerUpdateMetadata", () => {
  it("requires a release version", () => {
    const parsed = parseTillerUpdateMetadata(updateMarker("current-source", "0.2.27"));
    expect(parsed?.version).toBe("0.2.27");

    const { version: _version, ...withoutVersion } = updateMarker("current-source");
    expect(parseTillerUpdateMetadata(withoutVersion)).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resolveWorkerServiceNameMock.mockReset();
  resolveWorkerServiceNameMock.mockResolvedValue("tiller-hub");
  resolveAccountForHostnameMock.mockReset();
});

describe("checkForUpdate", () => {
  it("returns no update and skips GitHub release lookup for development builds", async () => {
    vi.stubGlobal("__TILLER_VERSION__", "0.1.1");
    vi.stubGlobal("__TILLER_BUILD_CHANNEL__", "development");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue({
          updateAvailable: true,
          currentUpdate: updateMarker("current-source"),
          latestUpdate: updateMarker("latest-source"),
          releaseNotesUrl: "https://example.com/stale",
        }),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await checkForUpdate(env as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.ENVS_KV.get).not.toHaveBeenCalled();
    expect(env.ENVS_KV.put).not.toHaveBeenCalled();
    expect(result.updateAvailable).toBe(false);
    expect(result.currentUpdate.sourceId).toBe("current-source");
    expect(result.latestUpdate.sourceId).toBe("current-source");
    expect(result.buildDiagnostics.channel).toBe("development");
    expect(result.hubRepo.status).toBe("not_checked");
    expect(result.issue).toBeUndefined();
  });

  it("defaults missing build channel to release behavior", async () => {
    vi.stubGlobal("__TILLER_VERSION__", "0.1.1");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    const fetchMock = mockLatestReleaseFetch(updateMarker("latest-source"));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await checkForUpdate(env as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.updateAvailable).toBe(true);
    expect(result.buildDiagnostics.channel).toBe("release");
  });

  it("ignores cached results from an older deployed source id", async () => {
    vi.stubGlobal("__TILLER_VERSION__", "0.1.1");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    const fetchMock = mockLatestReleaseFetch(updateMarker("latest-source"));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue({
          updateAvailable: true,
          currentUpdate: updateMarker("old-source"),
          latestUpdate: updateMarker("latest-source"),
          releaseNotesUrl: "https://example.com/stale",
        }),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await checkForUpdate(env as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      "https://api.github.com/repos/paperwing-dev/tiller-hub/releases/latest",
      "https://raw.githubusercontent.com/paperwing-dev/tiller-hub/tiller-hub-v0.2.0/tiller-update.json",
    ]);
    expect(result.currentUpdate.sourceId).toBe("current-source");
    expect(result.latestUpdate.sourceId).toBe("latest-source");
    expect(result.releaseNotesUrl).toBe("https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v0.2.0");
    expect(result.updateAvailable).toBe(true);
    expect(env.ENVS_KV.put).toHaveBeenCalledTimes(1);
  });

  it("uses source identity even when the running Hub version is newer than the latest public release tag", async () => {
    vi.stubGlobal("__TILLER_VERSION__", "0.2.35");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source", "0.2.35"));
    const fetchMock = mockLatestReleaseFetch(updateMarker("latest-public-source", "0.1.1"));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await checkForUpdate(env as never);

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      "https://api.github.com/repos/paperwing-dev/tiller-hub/releases/latest",
      "https://raw.githubusercontent.com/paperwing-dev/tiller-hub/tiller-hub-v0.1.1/tiller-update.json",
    ]);
    expect(result.currentUpdate.version).toBe("0.2.35");
    expect(result.latestUpdate.version).toBe("0.1.1");
    expect(result.updateAvailable).toBe(true);
  });

  it("surfaces update metadata lookup failures as an advanced-repair issue", async () => {
    vi.stubGlobal("__TILLER_VERSION__", "0.1.1");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      message: "Not Found",
    }, 404)));

    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await checkForUpdate(env as never);
    expect(result.updateAvailable).toBe(false);
    expect(result.updateMethod).toBe("advanced_repair");
    expect(result.issue?.code).toBe("update_check_failed");
  });

  it("clears cached hub-repo issues after the self-update repo is detected", async () => {
    vi.stubGlobal("__TILLER_VERSION__", "0.1.1");
    vi.stubGlobal("__TILLER_CURRENT_UPDATE__", updateMarker("current-source"));

    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue({
          updateAvailable: true,
          currentUpdate: updateMarker("current-source"),
          latestUpdate: updateMarker("latest-source"),
          buildDiagnostics: {
            channel: "release",
            version: "0.1.1",
            workersCiCommitSha: null,
            workersCiBranch: null,
          },
          hubRepo: { status: "missing", lastDetectedAt: "2026-05-27T00:00:00.000Z", visibleGitHubOwners: [] },
          updateMethod: "connect_hub_repo",
          issue: {
            code: "hub_repo_not_configured",
            message: "Connect the generated deploy-button GitHub repository before updating normally.",
          },
          releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub",
        }),
        put: vi.fn().mockResolvedValue(undefined),
      },
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({
          getAllConfig: vi.fn().mockResolvedValue({
            HUB_UPDATE_REPO_STATUS: "detected",
            HUB_UPDATE_REPO_OWNER: "me",
            HUB_UPDATE_REPO_REPO: "hub",
            HUB_UPDATE_REPO_ID: "123",
            HUB_UPDATE_REPO_INSTALLATION_ID: "456",
            HUB_UPDATE_REPO_BRANCH: "main",
            HUB_UPDATE_REPO_LABEL: "me/hub (main)",
            HUB_UPDATE_REPO_LAST_DETECTED_AT: "2026-05-27T01:00:00.000Z",
            HUB_UPDATE_REPO_DETECTED_BY: "manual",
          }),
        })),
      },
    };

    const result = await checkForUpdate(env as never);

    expect(result.updateMethod).toBe("github_repo");
    expect(result.hubRepo.status).toBe("detected");
    expect(result.issue).toBeUndefined();
  });
});

describe("buildTillerBindings", () => {
  it("preserves inherited vars and identifies missing resources", () => {
    const result = buildTillerBindings(
      {
        bindings: [
          { type: "plain_text", name: "DO_LOCATION_HINT", text: "wnam" },
          { type: "plain_text", name: "HUB_PUBLIC_URL", text: "https://tiller.example.com" },
          { type: "plain_text", name: "WORKER_SERVICE_NAME", text: "tiller-hub" },
          { type: "plain_text", name: "WORKERS_DEV_ALIAS_DISABLED", text: "true" },
          { type: "kv_namespace", name: "ENVS_KV", namespace_id: "kv-123" },
        ],
      },
      manifest,
    );

    expect(result.bindings).toEqual(
      expect.arrayContaining([
        { type: "plain_text", name: "DO_LOCATION_HINT", text: "wnam" },
        { type: "plain_text", name: "HUB_PUBLIC_URL", text: "https://tiller.example.com" },
        { type: "plain_text", name: "WORKER_SERVICE_NAME", text: "tiller-hub" },
        { type: "plain_text", name: "WORKERS_DEV_ALIAS_DISABLED", text: "true" },
        { type: "kv_namespace", name: "ENVS_KV", namespace_id: "kv-123" },
        { type: "durable_object_namespace", name: "HUB", class_name: "HubDO" },
        { type: "ai", name: "AI" },
        { type: "assets", name: "ASSETS" },
        { type: "worker_loader", name: "LOADER" },
        { type: "plain_text", name: "ENABLED_ENV_HARNESSES", text: "claude-code,codex" },
      ]),
    );
    expect(result.missingResources.kv).toEqual([]);
    expect(result.missingResources.r2).toEqual([
      { type: "r2_bucket", name: "BUCKET", name_derive: "worker" },
    ]);
  });

  it("refuses to proceed when live Worker secrets are present", () => {
    expect(() =>
      buildTillerBindings(
        {
          bindings: [
            { type: "secret_text", name: "OPENAI_API_KEY" },
          ],
        },
        manifest,
      )).toThrow(/Worker secret binding OPENAI_API_KEY/i);
  });
});

describe("resolveAccountAndScript", () => {
  it("matches workers.dev ownership by account subdomain before selecting a script owner", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        errors: [],
        result: [{ id: "acc-1" }, { id: "acc-2" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        errors: [],
        result: { subdomain: "other-account" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        errors: [],
        result: { subdomain: "preview-subdomain" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        errors: [],
        result: [{ name: "tiller-hub" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveAccountAndScript(
      {} as never,
      "cf-token",
      "https://tiller-hub.preview-subdomain.workers.dev/api/update/apply",
    )).resolves.toEqual({
      accountId: "acc-2",
      scriptName: "tiller-hub",
    });
  });
});

describe("ensureTillerResources", () => {
  it("throws when R2 creation fails and the bucket still does not exist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        errors: [{ code: 1000, message: "bad location hint" }],
        result: null,
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        errors: [{ code: 1003, message: "bucket not found" }],
        result: null,
      }), { status: 404, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureTillerResources(
      "cf-token",
      "acc-123",
      "tiller-hub",
      {
        kv: [],
        r2: [{ type: "r2_bucket", name: "BUCKET", name_derive: "worker" }],
      },
      {
        bindings: [{ type: "plain_text", name: "DO_LOCATION_HINT", text: "wnam" }],
      },
      [],
    )).rejects.toThrow(/bad location hint/i);
  });
});

describe("reconcileSandboxContainer", () => {
  it("preserves live rollout fields when patching the SandboxDO application", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      errors: [],
      result: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await reconcileContainerApplication(
      "cf-token",
      "acc-123",
      {
        class_name: "SandboxDO",
        app_name_suffix: "sandboxdo",
        image: "docker.io/jamieatlason/tiller-sandbox:v3",
        max_instances: 3,
        instance_type: "basic",
      },
      {
        id: "app-123",
        name: "tiller-hub-sandboxdo",
        instances: 2,
        max_instances: 2,
        constraints: { tier: 1 },
        affinities: { hardware_generation: "amd64" },
        scheduling_policy: "default",
        rollout_active_grace_period: 30,
        configuration: {
          image: "docker.io/jamieatlason/tiller-sandbox:v2",
          instance_type: "standard-1",
          memory_mib: 1024,
          observability: { logs: { enabled: true } },
        },
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      instances: 0,
      max_instances: 3,
      constraints: { tier: 1 },
      affinities: { hardware_generation: "amd64" },
      scheduling_policy: "default",
      rollout_active_grace_period: 30,
      configuration: {
        image: "docker.io/jamieatlason/tiller-sandbox:v3",
        instance_type: "basic",
        observability: { logs: { enabled: true } },
      },
    });
    expect(body.configuration.memory_mib).toBeUndefined();
  });
});

describe("container manifest helpers", () => {
  it("finds the DO binding name for a container class", () => {
    expect(findDurableObjectBindingNameForClass(
      {
        ...manifest,
        bindings: [
          ...manifest.bindings,
          { type: "durable_object_namespace", name: "SANDBOX", class_name: "SandboxDO" },
          { type: "durable_object_namespace", name: "SCM_BOOTSTRAP", class_name: "ScmBootstrapDO" },
          { type: "durable_object_namespace", name: "SCM_OPERATION", class_name: "ScmOperationDO" },
        ],
      },
      "ScmBootstrapDO",
    )).toBe("SCM_BOOTSTRAP");
  });

  it("builds known names for desired and legacy container suffixes", () => {
    expect(Array.from(buildKnownContainerNames("tiller-hub", manifest.containers)).sort()).toEqual([
      "tiller-hub-sandboxdo",
      "tiller-hub-scmbootstrapdo",
      "tiller-hub-scmoperationdo",
    ]);
  });
});
