import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

const mocks = vi.hoisted(() => ({
  fetchLatestTillerRelease: vi.fn(),
  clearUpdateCheckCache: vi.fn(),
  readTarEntries: vi.fn(),
  buildTillerBindings: vi.fn(),
  createAssetUploadSession: vi.fn(),
  createContainerApplication: vi.fn(),
  deleteContainerApplication: vi.fn(),
  deployTillerWorker: vi.fn(),
  ensureTillerResources: vi.fn(),
  findDurableObjectBindingNameForClass: vi.fn(),
  findDurableObjectNamespaceId: vi.fn(),
  getManifestContainerApps: vi.fn(),
  getTillerSettings: vi.fn(),
  listContainerApplications: vi.fn(),
  reconcileContainerApplication: vi.fn(),
  resolveAccountAndScript: vi.fn(),
  toAssetFiles: vi.fn(),
  uploadAssetBatch: vi.fn(),
  buildKnownContainerNames: vi.fn(),
}));

vi.mock("../update/check-release", () => ({
  fetchLatestTillerRelease: mocks.fetchLatestTillerRelease,
  clearUpdateCheckCache: mocks.clearUpdateCheckCache,
}));

vi.mock("../workspace/tar", () => ({
  readTarEntries: mocks.readTarEntries,
}));

vi.mock("../update/cloudflare-deploy", () => ({
  buildTillerBindings: mocks.buildTillerBindings,
  buildKnownContainerNames: mocks.buildKnownContainerNames,
  createAssetUploadSession: mocks.createAssetUploadSession,
  createContainerApplication: mocks.createContainerApplication,
  deleteContainerApplication: mocks.deleteContainerApplication,
  deployTillerWorker: mocks.deployTillerWorker,
  ensureTillerResources: mocks.ensureTillerResources,
  findDurableObjectBindingNameForClass: mocks.findDurableObjectBindingNameForClass,
  findDurableObjectNamespaceId: mocks.findDurableObjectNamespaceId,
  getManifestContainerApps: mocks.getManifestContainerApps,
  getTillerSettings: mocks.getTillerSettings,
  listContainerApplications: mocks.listContainerApplications,
  reconcileContainerApplication: mocks.reconcileContainerApplication,
  resolveAccountAndScript: mocks.resolveAccountAndScript,
  toAssetFiles: mocks.toAssetFiles,
  uploadAssetBatch: mocks.uploadAssetBatch,
}));

const { applyUpdate } = await import("../update/deploy");

describe("applyUpdate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchLatestTillerRelease.mockResolvedValue({
      assets: [
        { name: "manifest.json", browser_download_url: "https://example.test/manifest.json" },
        { name: "tiller-hub-v0.2.0.tar.gz", browser_download_url: "https://example.test/release.tar.gz" },
      ],
    });
    mocks.resolveAccountAndScript.mockResolvedValue({
      accountId: "acc-123",
      scriptName: "tiller-hub",
    });
    mocks.getManifestContainerApps.mockResolvedValue(new Map([
      [
        "SandboxDO",
        {
          id: "app-sandbox",
          name: "tiller-hub-sandboxdo",
          configuration: {
            image: "docker.io/jamieatlason/tiller-sandbox:v1",
            instance_type: "basic",
          },
          max_instances: 2,
        },
      ],
    ]));
    mocks.buildTillerBindings.mockReturnValue({
      bindings: [],
      missingResources: { kv: [], r2: [] },
    });
    mocks.ensureTillerResources.mockResolvedValue([]);
    mocks.readTarEntries.mockReturnValue(new Map([
      ["/worker/index.js", new Uint8Array([1])],
      ["/client/index.html", new Uint8Array([1])],
    ]));
    mocks.toAssetFiles.mockReturnValue([
      {
        path: "index.html",
        content: new Uint8Array([1]),
        contentType: "text/html",
      },
    ]);
    mocks.createAssetUploadSession.mockResolvedValue({
      session: { buckets: [], jwt: "assets-jwt" },
      manifest: {},
    });
    mocks.getTillerSettings
      .mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce({
        bindings: [
          { type: "durable_object_namespace", name: "SANDBOX", namespace_id: "ns-sandbox" },
          { type: "durable_object_namespace", name: "SCM_BOOTSTRAP", namespace_id: "ns-scm" },
          { type: "durable_object_namespace", name: "SCM_OPERATION", namespace_id: "ns-scm-op" },
        ],
      });
    mocks.findDurableObjectBindingNameForClass.mockImplementation((_manifest: unknown, className: string) =>
      className === "ScmBootstrapDO"
        ? "SCM_BOOTSTRAP"
        : className === "ScmOperationDO"
          ? "SCM_OPERATION"
          : "SANDBOX",
    );
    mocks.findDurableObjectNamespaceId.mockImplementation((_settings: unknown, bindingName: string) =>
      bindingName === "SCM_BOOTSTRAP"
        ? "ns-scm"
        : bindingName === "SCM_OPERATION"
          ? "ns-scm-op"
          : "ns-sandbox",
    );
    mocks.listContainerApplications.mockResolvedValue([
      {
        id: "app-sandbox",
        name: "tiller-hub-sandboxdo",
      },
    ]);
    mocks.buildKnownContainerNames.mockReturnValue(new Set([
      "tiller-hub-sandboxdo",
      "tiller-hub-scmbootstrapdo",
      "tiller-hub-scmoperationdo",
    ]));

    const archive = gzipSync(Buffer.from("irrelevant"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.test/manifest.json") {
        return new Response(JSON.stringify({
          version: "0.2.0",
          compatibility_date: "2025-01-29",
          compatibility_flags: ["nodejs_compat"],
          migrations: [],
          bindings: [
            { type: "durable_object_namespace", name: "SANDBOX", class_name: "SandboxDO" },
            { type: "durable_object_namespace", name: "SCM_BOOTSTRAP", class_name: "ScmBootstrapDO" },
            { type: "durable_object_namespace", name: "SCM_OPERATION", class_name: "ScmOperationDO" },
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
              max_instances: 4,
              instance_type: "basic",
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://example.test/release.tar.gz") {
        return new Response(archive, {
          status: 200,
          headers: { "Content-Type": "application/gzip" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reconciles existing containers and creates newly introduced manifest containers", async () => {
    await expect(applyUpdate({} as never, "https://tiller.example.com/api/update/apply", "cf-token"))
      .resolves.toEqual({ ok: true });

    expect(mocks.reconcileContainerApplication).toHaveBeenCalledTimes(3);
    expect(mocks.reconcileContainerApplication.mock.calls[0]?.[2]).toMatchObject({
      class_name: "SandboxDO",
    });
    expect(mocks.reconcileContainerApplication.mock.calls[0]?.[3]).toMatchObject({
      id: "app-sandbox",
    });
    expect(mocks.reconcileContainerApplication.mock.calls[1]?.[2]).toMatchObject({
      class_name: "ScmBootstrapDO",
    });
    expect(mocks.reconcileContainerApplication.mock.calls[1]?.[3]).toBeNull();
    expect(mocks.reconcileContainerApplication.mock.calls[2]?.[2]).toMatchObject({
      class_name: "ScmOperationDO",
    });
    expect(mocks.reconcileContainerApplication.mock.calls[2]?.[3]).toBeNull();

    expect(mocks.createContainerApplication).toHaveBeenCalledTimes(2);
    expect(mocks.createContainerApplication).toHaveBeenNthCalledWith(
      1,
      "cf-token",
      "acc-123",
      "tiller-hub",
      expect.objectContaining({ class_name: "ScmBootstrapDO" }),
      "ns-scm",
    );
    expect(mocks.createContainerApplication).toHaveBeenNthCalledWith(
      2,
      "cf-token",
      "acc-123",
      "tiller-hub",
      expect.objectContaining({ class_name: "ScmOperationDO" }),
      "ns-scm-op",
    );
    expect(mocks.deleteContainerApplication).not.toHaveBeenCalled();
    expect(mocks.clearUpdateCheckCache).toHaveBeenCalledOnce();
  });
});
