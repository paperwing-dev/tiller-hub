import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateManagedSelfHostRuntime } from "./self-host-runtime-contract.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const metadataPath = path.join(packageRoot, "tiller-update.json");
const DEFAULT_SOURCE_REPO = "paperwing-dev/tiller-hub";

const MANAGED_ROOT_FILES = new Set([
  ".gitignore",
  "README.md",
  "index.html",
  "package-lock.json",
  "package.json",
  "postcss.config.js",
  "tsconfig.app.json",
  "tsconfig.json",
  "tiller-update.json",
  "vite.config.ts",
  "vitest.config.ts",
  "wrangler.jsonc",
]);

const MANAGED_DIRECTORIES = new Set([
  "api",
  "scripts",
  "shared",
  "src",
]);

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".release",
  ".wrangler",
  "__tests__",
  "_archived",
  "dist",
  "docs",
  "node_modules",
  "test",
  "test-support",
]);

const EXCLUDED_FILE_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /\.tar\.gz$/i,
];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function resolveSourceId(args) {
  const explicit = args["source-id"]?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA?.trim()
    || process.env.GITHUB_SHA?.trim()
    || process.env.TILLER_UPDATE_SOURCE_ID?.trim();
  if (fromEnv) return fromEnv;

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(packageRoot, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "development";
  }
}

async function resolveVersion(args) {
  const explicit = args.version?.trim()
    || args["tiller-version"]?.trim()
    || process.env.TILLER_UPDATE_VERSION?.trim()
    || process.env.TILLER_BUILD_VERSION?.trim();
  if (explicit) return normalizeVersion(explicit);

  const packageJsonPath = path.resolve(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson.version === "string" && packageJson.version.trim()) {
    return normalizeVersion(packageJson.version);
  }

  throw new Error("--version is required for deploy-button update metadata");
}

function normalizeVersion(version) {
  const normalized = version.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
  if (!normalized) {
    throw new Error("version is required");
  }
  return normalized;
}

function formatVersionLabel(version) {
  return `Tiller Hub v${normalizeVersion(version)}`;
}

function isSafeManagedPath(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized.startsWith("/") || normalized.startsWith("\\")) return false;
  if (normalized.includes("\0")) return false;
  const parts = normalized.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return false;
  return normalized === parts.join("/");
}

function assertValidManagedFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("managedFiles must be a non-empty array");
  }
  const seen = new Set();
  for (const item of paths) {
    if (!isSafeManagedPath(item)) {
      throw new Error(`Unsafe managed file path: ${String(item)}`);
    }
    if (seen.has(item)) {
      throw new Error(`Duplicate managed file path: ${item}`);
    }
    seen.add(item);
    const top = item.split("/")[0];
    if (!MANAGED_ROOT_FILES.has(item) && !MANAGED_DIRECTORIES.has(top)) {
      throw new Error(`Managed file is outside the deploy-template surface: ${item}`);
    }
  }
}

function assertValidMarker(marker) {
  if (!marker || typeof marker !== "object") {
    throw new Error("tiller-update.json must be an object");
  }
  if (marker.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (marker.channel !== "deploy-button") throw new Error("channel must be deploy-button");
  if (marker.updateMode !== "full-source") throw new Error("updateMode must be full-source");
  if (marker.sourceRepo !== DEFAULT_SOURCE_REPO) throw new Error(`sourceRepo must be ${DEFAULT_SOURCE_REPO}`);
  if (typeof marker.sourceId !== "string" || !marker.sourceId.trim()) throw new Error("sourceId is required");
  if (typeof marker.version !== "string" || !marker.version.trim()) throw new Error("version is required");
  if (typeof marker.label !== "string" || !marker.label.trim()) throw new Error("label is required");
  assertValidManagedFiles(marker.managedFiles);
  if (marker.selfHostRuntime !== undefined) {
    validateManagedSelfHostRuntime(marker.selfHostRuntime);
  }
}

function assertValidPreviousManagedFiles(marker) {
  if (!marker || typeof marker !== "object") {
    throw new Error("Previous tiller-update.json must be an object");
  }
  assertValidManagedFiles(marker.managedFiles);
}

async function collectManagedFiles(directory = packageRoot, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const top = relativePath.split("/")[0];
    if (EXCLUDED_SEGMENTS.has(entry.name) || EXCLUDED_SEGMENTS.has(top)) continue;

    if (entry.isDirectory()) {
      if (!MANAGED_DIRECTORIES.has(top)) continue;
      files.push(...await collectManagedFiles(path.join(directory, entry.name), relativePath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!MANAGED_ROOT_FILES.has(relativePath) && !MANAGED_DIRECTORIES.has(top)) continue;
    if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) continue;
    files.push(relativePath);
  }

  return files;
}

async function fetchPreviousMarker(sourceRepo) {
  const token = process.env.TILLER_HUB_SYNC_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const response = await fetch(`https://api.github.com/repos/${sourceRepo}/contents/tiller-update.json?ref=main`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tiller-hub",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to read previous public update marker: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body || typeof body.content !== "string") {
    throw new Error("Previous public update marker response did not include content");
  }
  const normalized = body.content.replace(/\s+/g, "");
  const text = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(text);
}

async function readPreviousMarker(args, sourceRepo) {
  if (args["previous-file"]) {
    return JSON.parse(await readFile(path.resolve(args["previous-file"]), "utf8"));
  }
  if (args["skip-previous"] === "true") {
    return null;
  }
  if (!process.env.TILLER_HUB_SYNC_TOKEN?.trim() && !process.env.GH_TOKEN?.trim()) {
    return null;
  }
  return fetchPreviousMarker(sourceRepo);
}

function resolveAllowedManagedFileRemovals(args) {
  const raw = args["allow-managed-file-removal"]?.trim();
  if (!raw) return new Set();

  const allowed = new Set();
  for (const managedPath of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    if (!isSafeManagedPath(managedPath)) {
      throw new Error(`Unsafe allowed managed file removal: ${managedPath}`);
    }
    allowed.add(managedPath);
  }
  return allowed;
}

export function assertManagedFileRemovalPolicy(previous, next, allowedRemovals = new Set()) {
  if (!previous) return;
  assertValidPreviousManagedFiles(previous);
  const latest = new Set(next.managedFiles);
  const removed = previous.managedFiles.filter((managedPath) => !latest.has(managedPath));
  const unexpected = removed.filter((managedPath) => !allowedRemovals.has(managedPath));
  if (unexpected.length > 0) {
    throw new Error(`managedFiles removed without an explicit cutover allowance: ${unexpected.join(", ")}`);
  }
}

function resolveSelfHostRuntime(args) {
  const imageSourceId = args["self-host-runtime-image-source-id"]?.trim()
    || process.env.TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID?.trim();
  const sandboxImage = args["self-host-runtime-sandbox-image"]?.trim()
    || process.env.TILLER_SELF_HOST_RUNTIME_SANDBOX_IMAGE?.trim();

  if (!imageSourceId && !sandboxImage) {
    return undefined;
  }

  return validateManagedSelfHostRuntime({
    imageSourceId: imageSourceId || "",
    sandboxImage: sandboxImage || "",
  });
}

export async function buildUpdateMetadata(args = {}) {
  const sourceRepo = args["source-repo"]?.trim() || DEFAULT_SOURCE_REPO;
  if (sourceRepo !== DEFAULT_SOURCE_REPO) {
    throw new Error(`Only ${DEFAULT_SOURCE_REPO} is supported for deploy-button update metadata`);
  }

  const sourceId = resolveSourceId(args);
  const version = await resolveVersion(args);
  const selfHostRuntime = resolveSelfHostRuntime(args);
  const managedFiles = [...new Set(await collectManagedFiles())].sort((left, right) => left.localeCompare(right));
  assertValidManagedFiles(managedFiles);

  const metadata = {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo,
    sourceId,
    version,
    label: args.label?.trim() || formatVersionLabel(version),
    managedFiles,
    ...(selfHostRuntime ? { selfHostRuntime } : {}),
  };

  assertValidMarker(metadata);
  assertManagedFileRemovalPolicy(
    await readPreviousMarker(args, sourceRepo),
    metadata,
    resolveAllowedManagedFileRemovals(args),
  );
  return metadata;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metadata = await buildUpdateMetadata(args);
  if (args["check-only"] === "true") {
    console.log(`Validated update metadata with ${metadata.managedFiles.length} managed file(s)`);
    return;
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  console.log(`Wrote ${metadataPath} with ${metadata.managedFiles.length} managed file(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
