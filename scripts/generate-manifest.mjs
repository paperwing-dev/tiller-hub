import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dirname, "..");
const wranglerOutputPath = path.join(packageRoot, "dist", "tiller", "wrangler.json");
const packageJsonPath = path.join(packageRoot, "package.json");
const manifestPath = path.join(packageRoot, "manifest.json");
const legacyMigrationsPath = path.join(packageRoot, "scripts", "legacy-migrations.json");
const CONTAINER_IMAGE_TAG_ENV = "CONTAINER_IMAGE_TAG";
const GITHUB_JOB_IMAGE_TAG_ENV = "GITHUB_JOB_IMAGE_TAG";
const REQUIRE_PINNED_IMAGES_ENV = "TILLER_MANIFEST_REQUIRE_PINNED_IMAGES";

const SUPPORTED_UPDATE_TYPES = new Set([
  "durable_object_namespace",
  "kv_namespace",
  "r2_bucket",
  "ai",
  "assets",
  "worker_loader",
  "plain_text",
  "containers",
]);

const RUNTIME_VAR_EXCLUDES = new Set(["TILLER_REGION"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function toTitleSuffix(bindingName) {
  return bindingName.toLowerCase().replace(/_/g, "-");
}

function getContainerImageOverride(className) {
  if (className === "SandboxDO" || className === "PlannerRunDO" || className === "CodexAuthDO") {
    return process.env[CONTAINER_IMAGE_TAG_ENV]?.trim() || "";
  }
  if (className === "GitHubJobDO") {
    return process.env[GITHUB_JOB_IMAGE_TAG_ENV]?.trim() || "";
  }
  return "";
}

function isManagedContainerClass(className) {
  return className === "SandboxDO" || className === "GitHubJobDO" || className === "PlannerRunDO" || className === "CodexAuthDO";
}

function requirePinnedManagedImage(container) {
  if (!isManagedContainerClass(container.class_name)) return;
  if (typeof container.image !== "string" || container.image.endsWith(":stable")) {
    throw new Error(`Release manifest container ${container.class_name} must use a pinned image ref, not ${container.image}`);
  }
}

export function buildPlainTextBindings(config) {
  const vars = Object.entries(config.vars ?? {})
    .filter(([name]) => !RUNTIME_VAR_EXCLUDES.has(name))
    .map(([name, text]) => ({
      type: "plain_text",
      name,
      text: String(text),
    }));

  return vars;
}

function buildKvBindings(config) {
  return (config.kv_namespaces ?? []).map((binding) => ({
    type: "kv_namespace",
    name: binding.binding,
    title_suffix: toTitleSuffix(binding.binding),
  }));
}

function buildR2Bindings(config) {
  if (hasItems(config.r2_buckets)) {
    return config.r2_buckets.map((binding) => {
      if (binding.binding !== "BUCKET") {
        throw new Error(`Unsupported R2 binding ${binding.binding}; updater only supports the BUCKET binding`);
      }
      return {
        type: "r2_bucket",
        name: "BUCKET",
        name_derive: "worker",
      };
    });
  }

  return [
    {
      type: "r2_bucket",
      name: "BUCKET",
      name_derive: "worker",
    },
  ];
}

function buildManifestBindings(config) {
  const bindings = [];

  for (const binding of config.durable_objects?.bindings ?? []) {
    bindings.push({
      type: "durable_object_namespace",
      name: binding.name,
      class_name: binding.class_name,
    });
  }

  bindings.push(...buildKvBindings(config));
  bindings.push(...buildR2Bindings(config));

  if (config.ai?.binding) {
    bindings.push({
      type: "ai",
      name: config.ai.binding,
    });
  }

  if (config.assets?.binding) {
    bindings.push({
      type: "assets",
      name: config.assets.binding,
    });
  }

  for (const loader of config.worker_loaders ?? []) {
    bindings.push({
      type: "worker_loader",
      name: loader.binding,
    });
  }

  bindings.push(...buildPlainTextBindings(config));
  return bindings;
}

function assertNoUnsupportedBindings(config) {
  const unsupported = [];
  const checks = [
    ["workflows", hasItems(config.workflows)],
    ["send_email", hasItems(config.send_email)],
    ["queues", hasItems(config.queues?.producers) || hasItems(config.queues?.consumers)],
    ["d1", hasItems(config.d1_databases)],
    ["vectorize", hasItems(config.vectorize)],
    ["ai_search_namespace", hasItems(config.ai_search_namespaces)],
    ["ai_search", hasItems(config.ai_search)],
    ["hyperdrive", hasItems(config.hyperdrive)],
    ["service", hasItems(config.services)],
    ["analytics_engine", hasItems(config.analytics_engine_datasets)],
    ["dispatch_namespace", hasItems(config.dispatch_namespaces)],
    ["mtls_certificate", hasItems(config.mtls_certificates)],
    ["pipeline", hasItems(config.pipelines)],
    ["secrets_store_secret", hasItems(config.secrets_store_secrets)],
    ["unsafe_hello_world", hasItems(config.unsafe_hello_world)],
    ["ratelimit", hasItems(config.ratelimits)],
    ["vpc_service", hasItems(config.vpc_services)],
    ["vpc_network", hasItems(config.vpc_networks)],
    ["logfwdr", hasItems(config.logfwdr?.bindings)],
    ["browser", Boolean(config.browser)],
    ["images", Boolean(config.images)],
    ["stream", Boolean(config.stream)],
    ["media", Boolean(config.media)],
    ["version_metadata", Boolean(config.version_metadata)],
  ];

  for (const [type, present] of checks) {
    if (present) unsupported.push(type);
  }

  if (unsupported.length > 0) {
    throw new Error(`Unsupported binding type(s) in build output: ${unsupported.join(", ")}`);
  }
}

export function buildManifestContainers(config) {
  const containers = config.containers ?? [];
  const scriptName = config.name;
  const requirePinnedImages = process.env[REQUIRE_PINNED_IMAGES_ENV] === "1"
    || process.env[REQUIRE_PINNED_IMAGES_ENV] === "true";
  assert(typeof scriptName === "string" && scriptName.length > 0, "Build output is missing the Worker name");

  return containers.map((container) => {
    assert(
      typeof container.class_name === "string" && container.class_name.length > 0,
      "Container class_name is required in build output",
    );
    assert(
      typeof container.name === "string" && container.name.startsWith(`${scriptName}-`),
      "Container application name must be derived from the Worker name",
    );

    const manifestContainer = {
      class_name: container.class_name,
      app_name_suffix: container.name.slice(scriptName.length + 1),
      image: getContainerImageOverride(container.class_name) || container.image,
      max_instances: container.max_instances,
      instance_type: container.instance_type,
    };
    if (requirePinnedImages) requirePinnedManagedImage(manifestContainer);
    return manifestContainer;
  });
}

export function resolveLegacyMigrations(config, frozenMigrations) {
  const migrations = hasItems(config.migrations) ? config.migrations : frozenMigrations;
  assert(Array.isArray(migrations) && migrations.length > 0,
    "Legacy updater migrations are unavailable");
  return migrations;
}

async function main() {
  const [wranglerText, packageText, legacyMigrationsText] = await Promise.all([
    readFile(wranglerOutputPath, "utf8"),
    readFile(packageJsonPath, "utf8"),
    readFile(legacyMigrationsPath, "utf8"),
  ]);
  const config = JSON.parse(wranglerText);
  const packageJson = JSON.parse(packageText);

  assertNoUnsupportedBindings(config);

  const bindings = buildManifestBindings(config);
  const presentTypes = new Set(bindings.map((binding) => binding.type));
  presentTypes.add("containers");
  for (const type of presentTypes) {
    if (!SUPPORTED_UPDATE_TYPES.has(type)) {
      throw new Error(`Updater does not support binding type ${type}`);
    }
  }

  const manifest = {
    version: process.env.TILLER_BUILD_VERSION || packageJson.version,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags ?? [],
    // Temporary compatibility for the legacy updater. Fresh installation uses
    // only the declarative exports map in the release descriptor.
    migrations: resolveLegacyMigrations(config, JSON.parse(legacyMigrationsText)),
    bindings,
    containers: buildManifestContainers(config),
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Wrote ${manifestPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
