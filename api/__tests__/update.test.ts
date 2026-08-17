import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  compareVersions,
  INSTALLER_STABLE_CACHE_KEY,
  INSTALLER_STABLE_URL,
  parseStableReleaseSummary,
  UPDATE_CACHE_TTL_SECONDS,
} from "../update/check-release";
import { parseReleaseInfo } from "../update/release-info";
import updateRoutes from "../update/routes";
import type { Env, HonoEnv } from "../types";

const CURRENT_RELEASE = "a".repeat(40);
const OTHER_RELEASE = "b".repeat(40);
const IMAGE = `docker.io/jamieatlason/tiller-sandbox@sha256:${"c".repeat(64)}`;

function releaseInfo(version = "0.2.54", releaseId = CURRENT_RELEASE) {
  return {
    schemaVersion: 1,
    channel: "release",
    hubVersion: version,
    releaseId,
    selfHostRuntimeImage: IMAGE,
  } as const;
}

function stable(version = "0.2.54", releaseId = CURRENT_RELEASE) {
  return {
    releaseId,
    version,
    releaseNotesUrl: `https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v${version}`,
  };
}

function env(installerManaged = true): Env {
  const values = new Map<string, string>();
  return {
    ...(installerManaged ? { TILLER_INSTALLER_SCHEMA: "1", TILLER_RELEASE_ID: CURRENT_RELEASE } : {}),
    ENVS_KV: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = values.get(key) ?? null;
        return type === "json" && value ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
    },
  } as unknown as Env;
}

beforeEach(() => {
  vi.stubGlobal("__TILLER_VERSION__", "0.2.54");
  vi.stubGlobal("__TILLER_BUILD_CHANNEL__", "release");
  vi.stubGlobal("__TILLER_RELEASE_INFO__", releaseInfo());
  vi.stubGlobal("__WORKERS_CI_COMMIT_SHA__", "");
  vi.stubGlobal("__WORKERS_CI_BRANCH__", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReleaseInfo", () => {
  it("accepts only the small digest-pinned release contract", () => {
    expect(parseReleaseInfo(releaseInfo())).toEqual(releaseInfo());
    expect(parseReleaseInfo({ ...releaseInfo(), selfHostRuntimeImage: "docker.io/jamieatlason/tiller-sandbox:latest" })).toBeNull();
    expect(parseReleaseInfo({ ...releaseInfo(), managedFiles: ["api/index.ts"] })).toBeNull();
  });

  it("validates stable summaries and compares semantic versions", () => {
    expect(parseStableReleaseSummary(stable())).toEqual(stable());
    expect(parseStableReleaseSummary({ ...stable(), releaseNotesUrl: "http://example.test" })).toBeNull();
    expect(compareVersions("0.2.54", "0.3.1")).toBeLessThan(0);
    expect(compareVersions("0.3.1", "0.3.1")).toBe(0);
    expect(compareVersions("0.3.2", "0.3.1")).toBeGreaterThan(0);
  });
});

describe("GET /api/update/check", () => {
  it.each([
    ["installer-managed", true],
    ["unmanaged", false],
  ] as const)("reports %s installation status", async (kind, managed) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(stable("0.3.1", OTHER_RELEASE)));
    const result = await checkForUpdate(env(managed));
    expect(result).toMatchObject({
      kind,
      currentRelease: releaseInfo(),
      stableRelease: stable("0.3.1", OTHER_RELEASE),
      updateAvailable: true,
      errors: [],
    });
    expect(fetch).toHaveBeenCalledWith(INSTALLER_STABLE_URL, expect.any(Object));
  });

  it("does not offer an equal release and detects same-version replacement bytes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(Response.json(stable()));
    await expect(checkForUpdate(env())).resolves.toMatchObject({ updateAvailable: false });

    fetchMock.mockResolvedValueOnce(Response.json(stable("0.2.54", OTHER_RELEASE)));
    await expect(checkForUpdate(env())).resolves.toMatchObject({ updateAvailable: true });
  });

  it("uses the six-hour cache unless a manual refresh is requested", async () => {
    const target = env();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(stable("0.2.54", CURRENT_RELEASE)))
      .mockResolvedValueOnce(Response.json(stable("0.3.1", OTHER_RELEASE)));
    const app = new Hono<HonoEnv>();
    app.route("/", updateRoutes);

    const initialResponse = await app.request(
      "https://hub.example/api/update/check",
      {},
      target as never,
    );
    await expect(initialResponse.json()).resolves.toMatchObject({
      stableRelease: stable("0.2.54", CURRENT_RELEASE),
      updateAvailable: false,
    });
    expect(target.ENVS_KV.put).toHaveBeenCalledWith(
      INSTALLER_STABLE_CACHE_KEY,
      JSON.stringify(stable("0.2.54", CURRENT_RELEASE)),
      { expirationTtl: UPDATE_CACHE_TTL_SECONDS },
    );

    const cachedResponse = await app.request(
      "https://hub.example/api/update/check",
      {},
      target as never,
    );
    await expect(cachedResponse.json()).resolves.toMatchObject({
      stableRelease: stable("0.2.54", CURRENT_RELEASE),
      updateAvailable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const refreshedResponse = await app.request(
      "https://hub.example/api/update/check?refresh=1",
      {},
      target as never,
    );
    await expect(refreshedResponse.json()).resolves.toMatchObject({
      stableRelease: stable("0.3.1", OTHER_RELEASE),
      updateAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not downgrade a newer Hub", async () => {
    vi.stubGlobal("__TILLER_RELEASE_INFO__", releaseInfo("0.3.2"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(stable("0.3.1", OTHER_RELEASE)));
    await expect(checkForUpdate(env())).resolves.toMatchObject({ updateAvailable: false });
  });

  it("returns diagnostics when stable is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(checkForUpdate(env(false))).resolves.toMatchObject({
      kind: "unmanaged",
      stableRelease: null,
      updateAvailable: false,
      errors: [{ code: "stable_release_unavailable", retryable: true }],
    });
  });

  it("never offers stable maintenance for development builds", async () => {
    vi.stubGlobal("__TILLER_RELEASE_INFO__", { ...releaseInfo("0.1.0"), channel: "development" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(stable("0.3.1", OTHER_RELEASE)));
    await expect(checkForUpdate(env())).resolves.toMatchObject({ updateAvailable: false });
  });
});

describe("removed update endpoints", () => {
  it.each([
    "/api/update/hub-repo/detect",
    "/api/update/hub-repo/select",
    "/api/update/apply",
    "/api/update/repair/cloudflare-redeploy",
  ])("returns 404 for POST %s", async (pathname) => {
    const app = new Hono<HonoEnv>();
    app.route("/", updateRoutes);
    const response = await app.request(`https://hub.example${pathname}`, { method: "POST" }, env() as never);
    expect(response.status).toBe(404);
  });
});
