import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  ensureProtectedCustomDomain,
  normalizeScriptCloudflareError,
  probeHubState,
  resolveAccountForHostname,
  verifyBootstrapAccess,
  waitForHubAvailability,
} from "./access-bootstrap.mjs";

export const VALID_TILLER_REGIONS = ["wnam", "enam", "weur", "eeur", "apac", "oc"];

const VALID_TILLER_REGION_SET = new Set(VALID_TILLER_REGIONS);
const ROOT_WRANGLER_CONFIG = "wrangler.jsonc";
const GENERATED_DEPLOY_CONFIG = path.join(".wrangler", "deploy", "config.json");
const TEMP_DEPLOY_CONFIG_NAME = "wrangler.deploy.generated.json";
const TILLER_REGION_VAR = "TILLER_REGION";
const DO_LOCATION_HINT_VAR = "DO_LOCATION_HINT";
const R2_BUCKET_BINDING = "BUCKET";
const CUSTOM_DOMAIN_ENV = "TILLER_CUSTOM_DOMAIN";
const ACCESS_EMAILS_ENV = "TILLER_ACCESS_EMAILS";
const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_DEFAULT_ACCOUNT_ID_ENV = "CLOUDFLARE_DEFAULT_ACCOUNT_ID";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const HUB_PUBLIC_URL_VAR = "HUB_PUBLIC_URL";
const WORKER_SERVICE_NAME_VAR = "WORKER_SERVICE_NAME";
const WORKERS_DEV_ALIAS_DISABLED_VAR = "WORKERS_DEV_ALIAS_DISABLED";
const DOTENV_FILE = ".env";
const CONTAINER_IMAGE_TAG_ENV = "CONTAINER_IMAGE_TAG";
const SCM_BOOTSTRAP_IMAGE_TAG_ENV = "SCM_BOOTSTRAP_IMAGE_TAG";

class CommandError extends Error {
  constructor(message, { code, stderr, stdout } = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.stderr = stderr ?? "";
    this.stdout = stdout ?? "";
  }
}

export function parseJsonc(content, filePath) {
  const errors = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Failed to parse ${filePath}: ${details}`);
  }

  return value;
}

async function readJsoncFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return parseJsonc(content, filePath);
}

export function parseDotEnv(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

async function loadDotEnv(rootDir) {
  const dotenvPath = path.join(rootDir, DOTENV_FILE);
  try {
    await access(dotenvPath);
  } catch {
    return {};
  }

  const content = await readFile(dotenvPath, "utf8");
  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
  return parsed;
}

export function normalizeTillerRegion(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new Error(
      `Missing ${TILLER_REGION_VAR}. Set it in ${ROOT_WRANGLER_CONFIG} to one of: ${VALID_TILLER_REGIONS.join(", ")}.`,
    );
  }

  const value = rawValue.trim().toLowerCase();
  if (!VALID_TILLER_REGION_SET.has(value)) {
    throw new Error(
      `Invalid ${TILLER_REGION_VAR} "${rawValue}". Use one of: ${VALID_TILLER_REGIONS.join(", ")}.`,
    );
  }

  return value;
}

export function deriveBucketName(workerName) {
  if (typeof workerName !== "string" || workerName.trim().length === 0) {
    throw new Error(`Missing Worker name in ${ROOT_WRANGLER_CONFIG}.`);
  }

  const slug = workerName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const base = (slug || "tiller-hub").slice(0, 48).replace(/^-+|-+$/g, "") || "tiller-hub";
  const hash = createHash("sha1").update(workerName).digest("hex").slice(0, 8);
  return `${base}-r2-${hash}`;
}

export function extractBucketLocation(bucketInfo) {
  if (!bucketInfo || typeof bucketInfo !== "object") {
    return null;
  }

  const location =
    bucketInfo.location ??
    bucketInfo.locationHint ??
    bucketInfo.location_hint ??
    bucketInfo.region ??
    null;

  return typeof location === "string" ? location.toLowerCase() : null;
}

export function normalizeEmailList(rawValue) {
  if (typeof rawValue !== "string") return [];
  const deduped = new Set();
  for (const item of rawValue.split(/[\n,]/)) {
    const email = item.trim().toLowerCase();
    if (!email) continue;
    deduped.add(email);
  }
  return [...deduped];
}

function getNpxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function isMissingBucketError(stderr) {
  const text = stderr.toLowerCase();
  return (
    text.includes("does not exist") ||
    text.includes("not found") ||
    text.includes("could not find") ||
    text.includes("unknown bucket")
  );
}

function runCommand(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new CommandError(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`, {
          code,
          stderr,
          stdout,
        }),
      );
    });
  });
}

function runWrangler(args, options) {
  return runCommand(getNpxCommand(), ["wrangler", ...args], options);
}

export async function ensureWranglerAccountId(
  {
    customDomain,
    apiToken,
    accountId = process.env[CLOUDFLARE_ACCOUNT_ID_ENV]?.trim() || "",
    legacyAccountId = process.env[CLOUDFLARE_DEFAULT_ACCOUNT_ID_ENV]?.trim() || "",
  },
  options = {},
) {
  const explicitAccountId = accountId || legacyAccountId;
  if (explicitAccountId) {
    process.env[CLOUDFLARE_ACCOUNT_ID_ENV] = explicitAccountId;
    return explicitAccountId;
  }

  if (!customDomain || !apiToken) {
    return null;
  }

  const resolver = options.resolveAccountForHostnameImpl ?? resolveAccountForHostname;
  const resolved = await resolver(apiToken, customDomain);
  const resolvedAccountId = resolved?.accountId?.trim();
  if (!resolvedAccountId) {
    throw new Error(`Could not determine the Cloudflare account for ${customDomain}.`);
  }

  process.env[CLOUDFLARE_ACCOUNT_ID_ENV] = resolvedAccountId;
  return resolvedAccountId;
}

async function getBucketInfo(bucketName) {
  try {
    const { stdout } = await runWrangler(
      ["r2", "bucket", "info", bucketName, "--config", ROOT_WRANGLER_CONFIG, "--json"],
      {
        capture: true,
      },
    );
    return parseJsonc(stdout, "wrangler r2 bucket info output");
  } catch (error) {
    if (error instanceof CommandError && isMissingBucketError(error.stderr)) {
      return null;
    }
    throw error;
  }
}

async function cloudflareApi(apiToken, path, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ")
      || `Cloudflare API request failed: ${response.status}`;
    throw new Error(message);
  }

  return body.result;
}

async function listContainerApplications(apiToken, accountId) {
  return cloudflareApi(apiToken, `/accounts/${accountId}/containers/applications`, {
    method: "GET",
  });
}

function getContainerImageOverride(className, { sandboxImageTag = "", scmBootstrapImageTag = "" } = {}) {
  if (className === "SandboxDO") return sandboxImageTag;
  if (className === "ScmBootstrapDO" || className === "ScmOperationDO") return scmBootstrapImageTag;
  return "";
}

function isManagedContainerClass(className) {
  return className === "SandboxDO" || className === "ScmBootstrapDO" || className === "ScmOperationDO";
}

export function needsLiveContainerImageLookup(
  containers,
  { sandboxImageTag = "", scmBootstrapImageTag = "" } = {},
) {
  if (!Array.isArray(containers) || containers.length === 0) return false;

  return containers.some((container) => {
    const override = getContainerImageOverride(container.class_name, {
      sandboxImageTag,
      scmBootstrapImageTag,
    });
    return !override && typeof container?.name === "string" && container.name.length > 0
      && isManagedContainerClass(container.class_name);
  });
}

export function resolveContainerImages(
  containers,
  {
    sandboxImageTag = process.env[CONTAINER_IMAGE_TAG_ENV]?.trim() || "",
    scmBootstrapImageTag = process.env[SCM_BOOTSTRAP_IMAGE_TAG_ENV]?.trim() || "",
    liveContainerImages = new Map(),
  } = {},
) {
  const liveImageMap = liveContainerImages instanceof Map ? liveContainerImages : new Map(liveContainerImages ?? []);

  return (containers ?? []).map((container) => {
    const override = getContainerImageOverride(container.class_name, {
      sandboxImageTag,
      scmBootstrapImageTag,
    });
    if (override) {
      return {
        container: { ...container, image: override },
        source: "override",
      };
    }

    const liveImage = isManagedContainerClass(container.class_name) && typeof container?.name === "string"
      ? liveImageMap.get(container.name)
      : null;
    if (typeof liveImage === "string" && liveImage.length > 0) {
      return {
        container: { ...container, image: liveImage },
        source: "live",
      };
    }

    return {
      container: { ...container },
      source: "default",
    };
  });
}

async function resolveLiveContainerImages(apiToken, accountId, containers) {
  const names = new Set(
    (containers ?? [])
      .filter((container) => typeof container?.name === "string" && container.name.length > 0)
      .map((container) => container.name),
  );

  if (names.size === 0) return new Map();

  const applications = await listContainerApplications(apiToken, accountId);
  const liveContainerImages = new Map();

  for (const application of applications ?? []) {
    if (!names.has(application?.name)) continue;
    const image = application?.configuration?.image;
    if (typeof image === "string" && image.length > 0) {
      liveContainerImages.set(application.name, image);
    }
  }

  return liveContainerImages;
}

function logResolvedContainerImages(resolutions) {
  for (const resolution of resolutions ?? []) {
    const label = resolution.container?.name ?? resolution.container?.class_name ?? "container";
    if (resolution.source === "override") {
      console.log(`Container ${label}: using override image ${resolution.container.image}`);
      continue;
    }
    if (resolution.source === "live") {
      console.log(`Container ${label}: preserving live image ${resolution.container.image}`);
      continue;
    }
    console.log(`Container ${label}: using config default image ${resolution.container.image}`);
  }
}

async function resolveGeneratedDeployConfigPath(rootDir) {
  const redirectPath = path.join(rootDir, GENERATED_DEPLOY_CONFIG);
  const redirectConfig = await readJsoncFile(redirectPath);
  if (!redirectConfig || typeof redirectConfig.configPath !== "string") {
    throw new Error(`Missing configPath in ${GENERATED_DEPLOY_CONFIG}. Run the Vite build before deploy.`);
  }
  return path.resolve(path.dirname(redirectPath), redirectConfig.configPath);
}

export function buildDeployConfig(
  baseDeployConfig,
  {
    bucketName,
    region,
    customDomain,
    workerName,
    sandboxImageTag,
    scmBootstrapImageTag,
    liveContainerImages,
    resolvedContainers,
  } = {},
) {
  const nextConfig = structuredClone(baseDeployConfig);
  const vars = { ...(nextConfig.vars ?? {}) };

  delete vars[TILLER_REGION_VAR];
  delete vars[HUB_PUBLIC_URL_VAR];
  delete vars[WORKER_SERVICE_NAME_VAR];
  delete vars[WORKERS_DEV_ALIAS_DISABLED_VAR];
  vars[DO_LOCATION_HINT_VAR] = region;

  nextConfig.vars = vars;
  nextConfig.r2_buckets = [
    {
      binding: R2_BUCKET_BINDING,
      bucket_name: bucketName,
    },
  ];

  if (customDomain) {
    vars[HUB_PUBLIC_URL_VAR] = `https://${customDomain}`;
    vars[WORKER_SERVICE_NAME_VAR] = workerName;
    vars[WORKERS_DEV_ALIAS_DISABLED_VAR] = "true";
    nextConfig.workers_dev = false;
    nextConfig.preview_urls = false;
    nextConfig.routes = [
      {
        pattern: customDomain,
        custom_domain: true,
      },
    ];
  } else {
    nextConfig.workers_dev = true;
    delete nextConfig.preview_urls;
    delete nextConfig.routes;
  }

  if (nextConfig.containers?.length) {
    const nextContainers = resolvedContainers
      ?? resolveContainerImages(nextConfig.containers, {
        sandboxImageTag,
        scmBootstrapImageTag,
        liveContainerImages,
      }).map((resolution) => resolution.container);
    nextConfig.containers = structuredClone(nextContainers);
  }

  return nextConfig;
}

async function writeTempConfig(basePath, config) {
  const tempConfigPath = path.join(path.dirname(basePath), TEMP_DEPLOY_CONFIG_NAME);
  await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return tempConfigPath;
}

async function deployWithConfig(tempConfigPath) {
  try {
    await runWrangler(["deploy", "--config", tempConfigPath]);
  } finally {
    await rm(tempConfigPath, { force: true });
  }
}

async function main() {
  const rootDir = process.cwd();
  await loadDotEnv(rootDir);

  const rootConfigPath = path.join(rootDir, ROOT_WRANGLER_CONFIG);
  const rootConfig = await readJsoncFile(rootConfigPath);
  const workerName = rootConfig?.name;
  const region = normalizeTillerRegion(rootConfig?.vars?.[TILLER_REGION_VAR]);
  const bucketName = deriveBucketName(workerName);
  const customDomain = rootConfig?.vars?.[CUSTOM_DOMAIN_ENV]?.trim() || process.env[CUSTOM_DOMAIN_ENV]?.trim() || "";
  const apiToken = process.env[CLOUDFLARE_API_TOKEN_ENV]?.trim() || "";
  const sandboxImageTag = process.env[CONTAINER_IMAGE_TAG_ENV]?.trim() || "";
  const scmBootstrapImageTag = process.env[SCM_BOOTSTRAP_IMAGE_TAG_ENV]?.trim() || "";
  const emails = normalizeEmailList(process.env[ACCESS_EMAILS_ENV] ?? "");

  console.log(`Using ${TILLER_REGION_VAR}=${region}`);
  console.log(`Resolved R2 bucket name: ${bucketName}`);

  if (customDomain && (!apiToken || emails.length === 0)) {
    throw new Error(
      `Custom-domain deploys require ${CLOUDFLARE_API_TOKEN_ENV} and ${ACCESS_EMAILS_ENV} in ${DOTENV_FILE} or the environment.`,
    );
  }

  const hubUrl = customDomain ? `https://${customDomain}` : "";
  let existingHubState = "missing";
  let resolvedAccountId = "";
  let accessVerification = null;
  if (customDomain) existingHubState = await probeHubState(hubUrl);
  if (customDomain) {
    console.log(`Verifying Cloudflare API access for ${customDomain}...`);
    accessVerification = await verifyBootstrapAccess(apiToken, customDomain);
    resolvedAccountId = accessVerification.accountId;
  }
  resolvedAccountId = await ensureWranglerAccountId({ customDomain, apiToken, accountId: resolvedAccountId }) || "";

  const existingBucket = await getBucketInfo(bucketName);
  if (existingBucket) {
    const existingLocation = extractBucketLocation(existingBucket);
    if (existingLocation && existingLocation !== region) {
      throw new Error(
        `R2 bucket "${bucketName}" already exists in "${existingLocation}", not "${region}". Change the Worker name or delete the bucket before redeploying.`,
      );
    }
    console.log(`Reusing existing R2 bucket "${bucketName}".`);
  } else {
    console.log(`Creating R2 bucket "${bucketName}" in "${region}".`);
    await runWrangler([
      "r2",
      "bucket",
      "create",
      bucketName,
      "--config",
      ROOT_WRANGLER_CONFIG,
      "--location",
      region,
      "--update-config=false",
    ]);
  }

  const generatedDeployConfigPath = await resolveGeneratedDeployConfigPath(rootDir);
  const generatedDeployConfig = await readJsoncFile(generatedDeployConfigPath);
  const needsLiveLookup = needsLiveContainerImageLookup(generatedDeployConfig.containers, {
    sandboxImageTag,
    scmBootstrapImageTag,
  });
  let liveContainerImages = new Map();
  if (needsLiveLookup) {
    if (apiToken && resolvedAccountId) {
      liveContainerImages = await resolveLiveContainerImages(
        apiToken,
        resolvedAccountId,
        generatedDeployConfig.containers,
      );
    } else {
      console.log("Container image preservation unavailable; using config defaults for unpinned containers.");
    }
  }
  const resolvedContainerImages = resolveContainerImages(generatedDeployConfig.containers, {
    sandboxImageTag,
    scmBootstrapImageTag,
    liveContainerImages,
  });
  logResolvedContainerImages(resolvedContainerImages);
  const resolvedContainers = resolvedContainerImages.map((resolution) => resolution.container);
  const customDeployConfig = buildDeployConfig(generatedDeployConfig, {
    bucketName,
    region,
    customDomain: customDomain || undefined,
    workerName,
    resolvedContainers,
  });
  const fallbackDeployConfig = buildDeployConfig(generatedDeployConfig, {
    bucketName,
    region,
    workerName,
    resolvedContainers,
  });

  const customTempConfigPath = await writeTempConfig(generatedDeployConfigPath, customDeployConfig);
  await deployWithConfig(customTempConfigPath);

  if (!customDomain) {
    return;
  }

  try {
    console.log(`Waiting for ${hubUrl} to become reachable...`);
    let lastWaitMessage = "";
    const waitOptions = {
      onRetry({ attempt, attempts, message }) {
        if (message !== lastWaitMessage || attempt === 1 || attempt === attempts || attempt % 6 === 0) {
          console.log(`Waiting for ${hubUrl} (${attempt}/${attempts}): ${message}`);
          lastWaitMessage = message;
        }
      },
    };
    const availability = await waitForHubAvailability(hubUrl, {}, waitOptions);
    if (availability === "protected") {
      console.log(`Cloudflare Access is already active for ${hubUrl}. Skipping Access setup on this deploy.`);
      if (!accessVerification?.exactAppExists) {
        console.log("If this is not an existing Tiller-managed protected hub, finish Access setup from the UI instead.");
      }
      return;
    }

    console.log(`Enabling Cloudflare Access for ${hubUrl}...`);
    const result = await ensureProtectedCustomDomain(hubUrl, {
      apiToken,
      emails,
    });

    console.log(`Protected hub deployed at ${hubUrl}`);
    console.log(`Cloudflare Access client ID: ${result.clientId}`);
    console.log("Store the returned client ID and secret if you also want to run the local tiller client against this protected hub.");
  } catch (error) {
    if (existingHubState === "missing") {
      console.error("Custom-domain protection failed. Rolling back to the public workers.dev deployment.");
      const fallbackTempConfigPath = await writeTempConfig(generatedDeployConfigPath, fallbackDeployConfig);
      await deployWithConfig(fallbackTempConfigPath);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const hostname = process.env[CUSTOM_DOMAIN_ENV]?.trim() || "";
    console.error(normalizeScriptCloudflareError(error, hostname));
    process.exitCode = 1;
  });
}
