import type { Env } from "../types";
import { readTarEntries } from "../workspace/tar";
import { clearUpdateCheckCache, fetchLatestTillerRelease } from "./check-release";
import {
  buildTillerBindings,
  buildKnownContainerNames,
  createAssetUploadSession,
  createContainerApplication,
  deleteContainerApplication,
  deployTillerWorker,
  ensureTillerResources,
  findDurableObjectBindingNameForClass,
  findDurableObjectNamespaceId,
  getManifestContainerApps,
  getTillerSettings,
  listContainerApplications,
  reconcileContainerApplication,
  resolveAccountAndScript,
  toAssetFiles,
  uploadAssetBatch,
  type WorkerModule,
} from "./cloudflare-deploy";
import type { GitHubReleaseAsset, UpdateManifest, UpdateRelease } from "./types";

function getRequiredAsset(assets: GitHubReleaseAsset[], predicate: (asset: GitHubReleaseAsset) => boolean, label: string): GitHubReleaseAsset {
  const asset = assets.find(predicate);
  if (!asset) {
    throw new Error(`Latest release is missing ${label}`);
  }
  return asset;
}

async function fetchReleaseAssetBytes(asset: GitHubReleaseAsset): Promise<Uint8Array> {
  const response = await fetch(asset.browser_download_url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "tiller-hub",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download release asset ${asset.name}: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function fetchLatestReleaseManifest(
  release: UpdateRelease,
): Promise<{ manifest: UpdateManifest; archive: Uint8Array }> {
  const manifestAsset = getRequiredAsset(release.assets, (asset) => asset.name === "manifest.json", "manifest.json");
  const archiveAsset = getRequiredAsset(
    release.assets,
    (asset) => asset.name.endsWith(".tar.gz"),
    "release archive",
  );

  const [manifestBytes, archive] = await Promise.all([
    fetchReleaseAssetBytes(manifestAsset),
    fetchReleaseAssetBytes(archiveAsset),
  ]);

  const manifestText = new TextDecoder().decode(manifestBytes);
  return {
    manifest: JSON.parse(manifestText) as UpdateManifest,
    archive,
  };
}

async function gunzipArchive(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function collectWorkerModules(entries: Map<string, Uint8Array>): WorkerModule[] {
  const modules: WorkerModule[] = [];

  for (const [path, content] of entries) {
    if (!path.startsWith("/worker/")) continue;
    const relativePath = path.slice("/worker/".length);
    if (!relativePath || relativePath.startsWith(".") || !relativePath.endsWith(".js")) continue;
    modules.push({
      name: relativePath,
      content,
      type: "esm",
    });
  }

  modules.sort((left, right) => left.name.localeCompare(right.name));
  return modules;
}

function collectClientFiles(entries: Map<string, Uint8Array>) {
  return Array.from(entries.entries())
    .filter(([path]) => path.startsWith("/client/"))
    .map(([path, content]): [string, Uint8Array] => [path.slice("/client/".length), content])
    .filter(([path]) => Boolean(path));
}

async function uploadClientAssets(
  apiToken: string,
  accountId: string,
  scriptName: string,
  entries: Map<string, Uint8Array>,
): Promise<string> {
  const files = toAssetFiles(collectClientFiles(entries));
  const { session, manifest } = await createAssetUploadSession(apiToken, accountId, scriptName, files);

  if ((session.buckets ?? []).length === 0) {
    if (!session.jwt) {
      throw new Error("Cloudflare asset upload session did not return a completion JWT");
    }
    return session.jwt;
  }

  const filesByHash = new Map(files.map((file) => [manifest[file.path]?.hash, file] as const));
  if (!session.jwt) {
    throw new Error("Cloudflare asset upload session did not return an upload JWT");
  }
  let completionJwt = session.jwt ?? "";

  for (const bucket of session.buckets) {
    const batchFiles = bucket.map((hash) => {
      const file = filesByHash.get(hash);
      if (!file) {
        throw new Error(`Cloudflare requested an unknown asset hash: ${hash}`);
      }
      return file;
    });
    const result = await uploadAssetBatch(accountId, session.jwt ?? completionJwt, batchFiles, manifest);
    completionJwt = result.jwt ?? completionJwt;
  }

  if (!completionJwt) {
    throw new Error("Cloudflare asset upload did not produce a completion JWT");
  }

  return completionJwt;
}

function buildWorkerMetadata(
  manifest: UpdateManifest,
  bindings: Awaited<ReturnType<typeof ensureTillerResources>>,
  assetsJwt: string,
) {
  return {
    main_module: "index.js",
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags,
    migrations: manifest.migrations,
    bindings,
    containers: manifest.containers.map((container) => ({ class_name: container.class_name })),
    assets: {
      jwt: assetsJwt,
      config: {
        not_found_handling: "single-page-application",
      },
    },
  };
}

export async function applyUpdate(
  env: Env,
  requestUrl: string,
  apiTokenInput: string,
): Promise<{ ok: true }> {
  const apiToken = apiTokenInput.trim();
  if (!apiToken) {
    throw new Error("Cloudflare API token is required");
  }

  const release = await fetchLatestTillerRelease();
  const { manifest, archive } = await fetchLatestReleaseManifest(release);
  const { accountId, scriptName } = await resolveAccountAndScript(env, apiToken, requestUrl);
  const currentSettings = await getTillerSettings(apiToken, accountId, scriptName);
  const currentContainers = await getManifestContainerApps(apiToken, accountId, scriptName, manifest);
  const { bindings, missingResources } = buildTillerBindings(currentSettings, manifest);
  const explicitBindings = await ensureTillerResources(
    apiToken,
    accountId,
    scriptName,
    missingResources,
    currentSettings,
    bindings,
  );

  for (const container of manifest.containers) {
    await reconcileContainerApplication(
      apiToken,
      accountId,
      container,
      currentContainers.get(container.class_name) ?? null,
    );
  }

  const tarBytes = await gunzipArchive(archive);
  const entries = readTarEntries(tarBytes);
  const modules = collectWorkerModules(entries);
  if (!modules.some((module) => module.name === "index.js")) {
    throw new Error("Release archive is missing worker/index.js");
  }

  const assetsJwt = await uploadClientAssets(apiToken, accountId, scriptName, entries);
  await deployTillerWorker(
    apiToken,
    accountId,
    scriptName,
    buildWorkerMetadata(manifest, explicitBindings, assetsJwt),
    modules,
  );

  const updatedSettings = await getTillerSettings(apiToken, accountId, scriptName);
  const applications = await listContainerApplications(apiToken, accountId);

  for (const container of manifest.containers) {
    if (currentContainers.has(container.class_name)) continue;
    const bindingName = findDurableObjectBindingNameForClass(manifest, container.class_name);
    const namespaceId = findDurableObjectNamespaceId(updatedSettings, bindingName);
    await createContainerApplication(
      apiToken,
      accountId,
      scriptName,
      container,
      namespaceId,
    );
  }

  const knownContainerNames = buildKnownContainerNames(scriptName, manifest.containers);
  const desiredContainerNames = new Set(
    manifest.containers.map((container) => `${scriptName}-${container.app_name_suffix}`),
  );
  for (const application of applications) {
    if (!knownContainerNames.has(application.name)) continue;
    if (desiredContainerNames.has(application.name)) continue;
    await deleteContainerApplication(apiToken, accountId, application.id);
  }

  await clearUpdateCheckCache(env);
  return { ok: true };
}
