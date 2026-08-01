import { Buffer } from "node:buffer";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Env } from "../types";
import { CloudflareApiError } from "../cloudflare-errors";
import { resolveWorkerServiceName } from "../setup/cloudflare";
import type {
  ManifestKvBinding,
  ManifestR2Binding,
  UpdateManifest,
  UpdateManifestBinding,
  UpdateManifestContainer,
} from "./types";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const INHERITED_VARS = [
  "DO_LOCATION_HINT",
  "TILLER_UPDATE_SERVICE_DISABLED",
] as const;

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CloudflareAccount {
  id: string;
}

interface CloudflareWorkersSubdomain {
  subdomain?: string;
}

interface CloudflareWorkerScriptSummary {
  id?: string;
  name?: string;
}

interface CloudflareKvNamespace {
  id: string;
  title: string;
}

interface CloudflareR2Bucket {
  name: string;
}

export interface TillerWorkerBinding {
  type: string;
  name: string;
  text?: string;
  namespace_id?: string;
  bucket_name?: string;
  class_name?: string;
  script_name?: string;
  environment?: string;
  staging?: boolean;
  raw?: unknown;
}

export interface TillerWorkerSettings {
  bindings: TillerWorkerBinding[];
}

interface ContainerDurableObjectRef {
  namespace_id?: string;
}

interface ContainerConfiguration {
  image?: string;
  instance_type?: string;
  disk?: unknown;
  memory?: unknown;
  memory_mib?: unknown;
  vcpu?: unknown;
  [key: string]: unknown;
}

export interface CloudflareContainerApplication {
  id: string;
  name: string;
  instances?: number;
  max_instances?: number;
  constraints?: unknown;
  affinities?: unknown;
  scheduling_policy?: unknown;
  rollout_active_grace_period?: number;
  configuration: ContainerConfiguration;
  durable_objects?: ContainerDurableObjectRef;
}

interface AssetUploadSession {
  buckets: string[][];
  jwt?: string;
}

interface AssetUploadBatchResult {
  jwt?: string;
}

interface MissingResources {
  kv: ManifestKvBinding[];
  r2: ManifestR2Binding[];
}

export interface BindingBuildResult {
  bindings: TillerWorkerBinding[];
  missingResources: MissingResources;
}

export interface WorkerModule {
  name: string;
  content: Uint8Array;
  type: "esm";
}

interface AssetFile {
  path: string;
  content: Uint8Array;
  contentType: string;
}

function deriveBucketName(workerName: string): string {
  if (!workerName.trim()) {
    throw new Error("Worker script name is required");
  }

  const slug = workerName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const base = (slug || "tiller-hub").slice(0, 48).replace(/^-+|-+$/g, "") || "tiller-hub";
  return `${base}-r2-${hashBytes(new TextEncoder().encode(workerName)).slice(0, 8)}`;
}

function deriveContainerAppName(scriptName: string, suffix: string): string {
  return `${scriptName}-${suffix}`;
}

function normalizeWorkerHost(requestUrl: string): string {
  return new URL(requestUrl).hostname.toLowerCase();
}

function getWorkersDevAccountSubdomain(hostname: string): string | null {
  const labels = hostname.trim().toLowerCase().split(".");
  if (labels.length < 4 || labels.at(-2) !== "workers" || labels.at(-1) !== "dev") {
    return null;
  }
  return labels.at(-3) ?? null;
}

function toApiError(
  responseStatus: number,
  body: CloudflareEnvelope<unknown> | null,
  path: string,
  method: string,
): never {
  const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ")
    || `Cloudflare API request failed: ${responseStatus}`;
  throw new CloudflareApiError({
    message,
    status: responseStatus,
    path,
    method,
    errors: body?.errors,
  });
}

export async function cloudflareApi<T>(
  apiToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${apiToken}`);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers,
  });

  let body: CloudflareEnvelope<T> | null = null;
  try {
    body = await response.json<CloudflareEnvelope<T>>();
  } catch {
    body = null;
  }

  if (response.ok && response.status === 204) {
    return undefined as T;
  }

  if (!response.ok || !body?.success) {
    toApiError(response.status, body, path, method);
  }

  return body.result;
}

async function listAccessibleAccounts(apiToken: string): Promise<CloudflareAccount[]> {
  const accounts: CloudflareAccount[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareAccount[]>(
      apiToken,
      `/accounts?per_page=50&page=${page}`,
      { method: "GET" },
    );
    accounts.push(...result);
    if (result.length < 50) break;
  }

  return accounts;
}

async function listWorkerScripts(
  apiToken: string,
  accountId: string,
): Promise<CloudflareWorkerScriptSummary[]> {
  const scripts: CloudflareWorkerScriptSummary[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareWorkerScriptSummary[]>(
      apiToken,
      `/accounts/${accountId}/workers/scripts?per_page=100&page=${page}`,
      { method: "GET" },
    );
    scripts.push(...result);
    if (result.length < 100) break;
  }

  return scripts;
}

async function getAccountWorkersSubdomain(
  apiToken: string,
  accountId: string,
): Promise<string | null> {
  try {
    const result = await cloudflareApi<CloudflareWorkersSubdomain>(
      apiToken,
      `/accounts/${accountId}/workers/subdomain`,
      { method: "GET" },
    );
    const subdomain = result.subdomain?.trim().toLowerCase();
    return subdomain || null;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function resolveAccountAndScript(
  env: Env,
  apiToken: string,
  requestUrl: string,
): Promise<{ accountId: string; scriptName: string }> {
  const scriptName = await resolveWorkerServiceName(env, requestUrl);
  if (!scriptName) {
    throw new Error("Could not determine the Worker service name");
  }

  const hostname = normalizeWorkerHost(requestUrl);
  if (!hostname.endsWith(".workers.dev")) {
    throw new Error("Hub updates require the exact canonical workers.dev origin.");
  }

  const accounts = await listAccessibleAccounts(apiToken);
  const expectedSubdomain = getWorkersDevAccountSubdomain(hostname);
  if (!expectedSubdomain) {
    throw new Error("Could not determine the workers.dev account subdomain from the request URL");
  }

  const matchingAccountIds: string[] = [];
  for (const account of accounts) {
    const accountSubdomain = await getAccountWorkersSubdomain(apiToken, account.id);
    if (accountSubdomain !== expectedSubdomain) continue;

    const scripts = await listWorkerScripts(apiToken, account.id);
    if (scripts.some((script) => script.id === scriptName || script.name === scriptName)) {
      matchingAccountIds.push(account.id);
    }
  }

  if (matchingAccountIds.length === 1) {
    return {
      accountId: matchingAccountIds[0],
      scriptName,
    };
  }
  if (matchingAccountIds.length > 1) {
    throw new Error(
      `Multiple accessible Cloudflare accounts match ${scriptName}.${expectedSubdomain}.workers.dev; retry with a token scoped to the owning account.`,
    );
  }

  throw new Error(
    `Could not find Worker ${scriptName} in the Cloudflare account that owns ${expectedSubdomain}.workers.dev`,
  );
}

export async function getTillerSettings(
  apiToken: string,
  accountId: string,
  scriptName: string,
): Promise<TillerWorkerSettings> {
  return cloudflareApi<TillerWorkerSettings>(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    { method: "GET" },
  );
}

export async function listContainerApplications(
  apiToken: string,
  accountId: string,
): Promise<CloudflareContainerApplication[]> {
  return cloudflareApi<CloudflareContainerApplication[]>(
    apiToken,
    `/accounts/${accountId}/containers/applications`,
    { method: "GET" },
  );
}

function deriveManifestContainerName(
  scriptName: string,
  container: UpdateManifestContainer,
): string {
  return deriveContainerAppName(scriptName, container.app_name_suffix);
}

export async function getManifestContainerApps(
  apiToken: string,
  accountId: string,
  scriptName: string,
  manifest: UpdateManifest,
): Promise<Map<string, CloudflareContainerApplication>> {
  const applications = await listContainerApplications(apiToken, accountId);
  const matched = new Map<string, CloudflareContainerApplication>();
  for (const container of manifest.containers) {
    const expectedName = deriveManifestContainerName(scriptName, container);
    const app = applications.find((candidate) => candidate.name === expectedName);
    if (app) {
      matched.set(container.class_name, app);
    }
  }
  return matched;
}

function getBindingMap(bindings: TillerWorkerBinding[]): Map<string, TillerWorkerBinding> {
  return new Map(bindings.map((binding) => [binding.name, binding]));
}

function getInheritedPlainTextBinding(
  currentBindings: Map<string, TillerWorkerBinding>,
  name: (typeof INHERITED_VARS)[number],
): TillerWorkerBinding | null {
  const binding = currentBindings.get(name);
  if (!binding) return null;
  if (binding.type !== "plain_text" || typeof binding.text !== "string") {
    throw new Error(`Inherited binding ${name} must be a plain-text variable`);
  }
  return {
    type: "plain_text",
    name,
    text: binding.text,
  };
}

export function buildTillerBindings(
  currentSettings: TillerWorkerSettings,
  manifest: UpdateManifest,
): BindingBuildResult {
  const currentBindings = getBindingMap(currentSettings.bindings ?? []);
  for (const binding of currentSettings.bindings ?? []) {
    if (binding.type === "secret_text" || binding.type === "secret_key") {
      throw new Error(
        `Update refused because Worker secret binding ${binding.name} is present. Remove Worker secrets and store them in hub config before retrying.`,
      );
    }
  }

  const bindings: TillerWorkerBinding[] = [];
  for (const inheritedName of INHERITED_VARS) {
    const inheritedBinding = getInheritedPlainTextBinding(currentBindings, inheritedName);
    if (inheritedBinding) bindings.push(inheritedBinding);
  }

  const missingResources: MissingResources = {
    kv: [],
    r2: [],
  };

  for (const manifestBinding of manifest.bindings) {
    switch (manifestBinding.type) {
      case "durable_object_namespace":
        bindings.push({
          type: "durable_object_namespace",
          name: manifestBinding.name,
          class_name: manifestBinding.class_name,
        });
        break;
      case "kv_namespace": {
        const current = currentBindings.get(manifestBinding.name);
        if (current?.type === "kv_namespace" && typeof current.namespace_id === "string") {
          bindings.push({
            type: "kv_namespace",
            name: manifestBinding.name,
            namespace_id: current.namespace_id,
          });
        } else {
          missingResources.kv.push(manifestBinding);
        }
        break;
      }
      case "r2_bucket": {
        const current = currentBindings.get(manifestBinding.name);
        if (current?.type === "r2_bucket" && typeof current.bucket_name === "string") {
          bindings.push({
            type: "r2_bucket",
            name: manifestBinding.name,
            bucket_name: current.bucket_name,
          });
        } else {
          missingResources.r2.push(manifestBinding);
        }
        break;
      }
      case "ai":
      case "assets":
      case "worker_loader":
        bindings.push({
          type: manifestBinding.type,
          name: manifestBinding.name,
        });
        break;
      case "plain_text":
        bindings.push({
          type: "plain_text",
          name: manifestBinding.name,
          text: manifestBinding.text,
        });
        break;
      default: {
        const unreachable: never = manifestBinding;
        throw new Error(`Unsupported manifest binding: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return {
    bindings,
    missingResources,
  };
}

async function listKvNamespaces(apiToken: string, accountId: string): Promise<CloudflareKvNamespace[]> {
  const namespaces: CloudflareKvNamespace[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareKvNamespace[]>(
      apiToken,
      `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
      { method: "GET" },
    );
    namespaces.push(...result);
    if (result.length < 100) break;
  }

  return namespaces;
}

async function ensureKvNamespace(
  apiToken: string,
  accountId: string,
  title: string,
): Promise<string> {
  try {
    const created = await cloudflareApi<{ id: string }>(
      apiToken,
      `/accounts/${accountId}/storage/kv/namespaces`,
      {
        method: "POST",
        body: JSON.stringify({ title }),
      },
    );
    return created.id;
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 400) {
      throw error;
    }

    const namespaces = await listKvNamespaces(apiToken, accountId);
    const existing = namespaces.find((namespace) => namespace.title === title);
    if (!existing) throw error;
    return existing.id;
  }
}

function getPlainTextBindingValue(
  currentSettings: TillerWorkerSettings,
  name: string,
): string | null {
  const binding = (currentSettings.bindings ?? []).find((candidate) => candidate.name === name);
  return binding?.type === "plain_text" && typeof binding.text === "string"
    ? binding.text
    : null;
}

async function ensureR2Bucket(
  apiToken: string,
  accountId: string,
  scriptName: string,
  currentSettings: TillerWorkerSettings,
): Promise<string> {
  const bucketName = deriveBucketName(scriptName);
  const locationHint = getPlainTextBindingValue(currentSettings, "DO_LOCATION_HINT");
  if (!locationHint) {
    throw new Error("Cannot create the BUCKET binding because DO_LOCATION_HINT is missing from the live Worker settings");
  }

  try {
    await cloudflareApi(
      apiToken,
      `/accounts/${accountId}/r2/buckets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: bucketName,
          locationHint,
        }),
      },
    );
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || (error.status !== 400 && error.status !== 409)) {
      throw error;
    }

    try {
      await cloudflareApi<CloudflareR2Bucket>(
        apiToken,
        `/accounts/${accountId}/r2/buckets/${bucketName}`,
        { method: "GET" },
      );
    } catch (lookupError) {
      if (lookupError instanceof CloudflareApiError && lookupError.status === 404) {
        throw error;
      }
      throw lookupError;
    }
  }

  return bucketName;
}

export async function ensureTillerResources(
  apiToken: string,
  accountId: string,
  scriptName: string,
  missingResources: MissingResources,
  currentSettings: TillerWorkerSettings,
  bindings: TillerWorkerBinding[],
): Promise<TillerWorkerBinding[]> {
  const nextBindings = [...bindings];

  for (const kvBinding of missingResources.kv) {
    const namespaceId = await ensureKvNamespace(
      apiToken,
      accountId,
      `${scriptName}-${kvBinding.title_suffix}`,
    );
    nextBindings.push({
      type: "kv_namespace",
      name: kvBinding.name,
      namespace_id: namespaceId,
    });
  }

  for (const r2Binding of missingResources.r2) {
    if (r2Binding.name_derive !== "worker") {
      throw new Error(`Unsupported R2 derivation strategy for ${r2Binding.name}`);
    }

    const bucketName = await ensureR2Bucket(apiToken, accountId, scriptName, currentSettings);
    nextBindings.push({
      type: "r2_bucket",
      name: r2Binding.name,
      bucket_name: bucketName,
    });
  }

  return nextBindings;
}

function containerPatchRequired(
  currentApp: CloudflareContainerApplication,
  container: UpdateManifestContainer,
): boolean {
  return currentApp.configuration.image !== container.image
    || currentApp.configuration.instance_type !== container.instance_type
    || (currentApp.max_instances ?? 0) !== container.max_instances;
}

export async function reconcileContainerApplication(
  apiToken: string,
  accountId: string,
  container: UpdateManifestContainer,
  currentApp: CloudflareContainerApplication | null,
): Promise<void> {
  if (!currentApp || !containerPatchRequired(currentApp, container)) return;

  const nextConfiguration: ContainerConfiguration = {
    ...currentApp.configuration,
    image: container.image,
    instance_type: container.instance_type,
  };
  delete nextConfiguration.disk;
  delete nextConfiguration.memory;
  delete nextConfiguration.memory_mib;
  delete nextConfiguration.vcpu;

  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/containers/applications/${currentApp.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        configuration: nextConfiguration,
        instances: container.max_instances !== undefined ? 0 : currentApp.instances,
        max_instances: container.max_instances,
        constraints: currentApp.constraints,
        affinities: currentApp.affinities,
        scheduling_policy: currentApp.scheduling_policy,
        rollout_active_grace_period: currentApp.rollout_active_grace_period,
      }),
    },
  );
}

export async function createContainerApplication(
  apiToken: string,
  accountId: string,
  scriptName: string,
  container: UpdateManifestContainer,
  namespaceId: string,
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/containers/applications`,
    {
      method: "POST",
      body: JSON.stringify({
        name: deriveContainerAppName(scriptName, container.app_name_suffix),
        configuration: {
          image: container.image,
          instance_type: container.instance_type,
        },
        instances: 0,
        max_instances: container.max_instances,
        scheduling_policy: "default",
        durable_objects: {
          namespace_id: namespaceId,
        },
      }),
    },
  );
}

export async function deleteContainerApplication(
  apiToken: string,
  accountId: string,
  applicationId: string,
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/containers/applications/${applicationId}`,
    {
      method: "DELETE",
    },
  );
}

function hashBytes(content: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of content) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hashAssetContent(filePath: string, content: Uint8Array): string {
  const filename = filePath.split("/").pop() ?? "";
  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot > 0 ? filename.slice(lastDot + 1) : "";
  const base64Contents = Buffer.from(content).toString("base64");
  return bytesToHex(blake3(new TextEncoder().encode(base64Contents + extension))).slice(0, 32);
}

function buildAssetManifest(files: AssetFile[]): Record<string, { hash: string; size: number }> {
  const manifest: Record<string, { hash: string; size: number }> = {};

  for (const file of files) {
    manifest[file.path] = {
      hash: hashAssetContent(file.path, file.content),
      size: file.content.byteLength,
    };
  }

  return manifest;
}

export async function createAssetUploadSession(
  apiToken: string,
  accountId: string,
  scriptName: string,
  files: AssetFile[],
): Promise<{ session: AssetUploadSession; manifest: Record<string, { hash: string; size: number }> }> {
  const manifest = buildAssetManifest(files);
  const session = await cloudflareApi<AssetUploadSession>(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    {
      method: "POST",
      body: JSON.stringify({ manifest }),
    },
  );

  return { session, manifest };
}

function encodeBase64(content: Uint8Array): string {
  return Buffer.from(content).toString("base64");
}

export async function uploadAssetBatch(
  accountId: string,
  jwt: string,
  files: AssetFile[],
  manifest: Record<string, { hash: string; size: number }>,
): Promise<AssetUploadBatchResult> {
  const formData = new FormData();
  for (const file of files) {
    const hash = manifest[file.path]?.hash;
    if (!hash) {
      throw new Error(`Asset hash missing for ${file.path}`);
    }
    formData.append(
      hash,
      new File(
        [encodeBase64(file.content)],
        hash,
        { type: file.contentType || "application/null" },
      ),
      hash,
    );
  }

  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      body: formData,
    },
  );

  let body: CloudflareEnvelope<AssetUploadBatchResult> | null = null;
  try {
    body = await response.json<CloudflareEnvelope<AssetUploadBatchResult>>();
  } catch {
    body = null;
  }

  if (!response.ok || !body?.success) {
    toApiError(response.status, body, `/accounts/${accountId}/workers/assets/upload?base64=true`, "POST");
  }

  return body.result;
}

function toModuleMimeType(type: WorkerModule["type"]): string {
  switch (type) {
    case "esm":
      return "application/javascript+module";
    default: {
      const unreachable: never = type;
      throw new Error(`Unsupported Worker module type: ${String(unreachable)}`);
    }
  }
}

export async function deployTillerWorker(
  apiToken: string,
  accountId: string,
  scriptName: string,
  metadata: Record<string, unknown>,
  modules: WorkerModule[],
): Promise<void> {
  const formData = new FormData();
  formData.set("metadata", JSON.stringify(metadata));

  for (const module of modules) {
    formData.set(
      module.name,
      new File([module.content], module.name, { type: toModuleMimeType(module.type) }),
    );
  }

  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${scriptName}?excludeScript=true`,
    {
      method: "PUT",
      body: formData,
    },
  );
}

export function findDurableObjectNamespaceId(
  settings: TillerWorkerSettings,
  bindingName: string,
): string {
  const binding = settings.bindings.find((candidate) =>
    candidate.type === "durable_object_namespace" && candidate.name === bindingName
  );
  if (!binding?.namespace_id) {
    throw new Error(`Durable Object binding ${bindingName} is missing a namespace_id`);
  }
  return binding.namespace_id;
}

export function findDurableObjectBindingNameForClass(
  manifest: UpdateManifest,
  className: string,
): string {
  const binding = manifest.bindings.find((candidate) =>
    candidate.type === "durable_object_namespace" && candidate.class_name === className
  );
  if (!binding || binding.type !== "durable_object_namespace") {
    throw new Error(`Durable Object binding for container class ${className} is missing from the update manifest`);
  }
  return binding.name;
}

export function buildKnownContainerNames(
  scriptName: string,
  containers: UpdateManifestContainer[],
): Set<string> {
  const names = new Set<string>();
  for (const container of containers) {
    names.add(deriveManifestContainerName(scriptName, container));
    names.add(deriveContainerAppName(scriptName, container.class_name.toLowerCase()));
  }
  return names;
}

function guessContentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

export function toAssetFiles(entries: Iterable<[string, Uint8Array]>): AssetFile[] {
  const files: AssetFile[] = [];

  for (const [path, content] of entries) {
    files.push({
      path,
      content,
      contentType: guessContentType(path),
    });
  }

  return files;
}
