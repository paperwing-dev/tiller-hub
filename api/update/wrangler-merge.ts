import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const PRESERVED_VAR_KEYS = new Set([
  "TILLER_REGION",
  "HUB_PUBLIC_URL",
  "WORKER_SERVICE_NAME",
  "WORKERS_DEV_ALIAS_DISABLED",
  "DO_LOCATION_HINT",
]);

const TILLER_OWNED_VAR_KEYS = new Set([
  "ENABLED_ENV_HARNESSES",
  "LOCAL_DEV_ONLY_BACKEND",
]);

const RESOURCE_KEYS = new Set([
  "id",
  "preview_id",
  "namespace_id",
  "bucket",
  "bucket_name",
  "database_id",
  "database_name",
  "queue",
  "queue_name",
  "service",
  "script_name",
  "environment",
  "name",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsoncObject(text: string, label: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    const error = errors[0];
    throw new Error(`${label} is not valid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must parse to an object`);
  }
  return parsed;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeVars(
  currentVars: unknown,
  upstreamVars: unknown,
): Record<string, unknown> | undefined {
  const current = isRecord(currentVars) ? currentVars : {};
  const upstream = isRecord(upstreamVars) ? upstreamVars : {};
  const merged: Record<string, unknown> = { ...upstream };

  for (const key of PRESERVED_VAR_KEYS) {
    if (key in current) merged[key] = current[key];
  }

  for (const [key, value] of Object.entries(current)) {
    if (key in upstream) continue;
    if (PRESERVED_VAR_KEYS.has(key) || TILLER_OWNED_VAR_KEYS.has(key)) continue;
    merged[key] = value;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function itemKey(item: unknown, keyName: "binding" | "name" | "class_name"): string | null {
  if (!isRecord(item)) return null;
  const value = item[keyName];
  return typeof value === "string" && value.trim() ? value : null;
}

function mergeResourceFields<T>(
  upstreamItem: T,
  currentItem: unknown,
): T {
  if (!isRecord(upstreamItem) || !isRecord(currentItem)) return upstreamItem;
  const merged: Record<string, unknown> = { ...upstreamItem };
  for (const [key, value] of Object.entries(currentItem)) {
    if (!RESOURCE_KEYS.has(key)) continue;
    if (key in upstreamItem && key !== "name") continue;
    merged[key] = value;
  }
  return merged as T;
}

function mergeArrayByKey<T>(
  currentItems: unknown,
  upstreamItems: unknown,
  keyName: "binding" | "name" | "class_name",
): T[] | undefined {
  if (!Array.isArray(upstreamItems)) return undefined;
  const currentByKey = new Map<string, unknown>();
  if (Array.isArray(currentItems)) {
    for (const item of currentItems) {
      const key = itemKey(item, keyName);
      if (key) currentByKey.set(key, item);
    }
  }

  return upstreamItems.map((upstreamItem) => {
    const key = itemKey(upstreamItem, keyName);
    return key ? mergeResourceFields(upstreamItem, currentByKey.get(key)) : upstreamItem;
  }) as T[];
}

function mergeDurableObjects(current: unknown, upstream: unknown): unknown {
  if (!isRecord(upstream)) return upstream;
  const currentObject = isRecord(current) ? current : {};
  const merged = clone(upstream);
  const bindings = mergeArrayByKey(
    currentObject.bindings,
    upstream.bindings,
    "name",
  );
  if (bindings) {
    (merged as Record<string, unknown>).bindings = bindings;
  }
  return merged;
}

export function mergeWranglerJsonc(currentText: string, upstreamText: string): string {
  const current = parseJsoncObject(currentText, "Current wrangler.jsonc");
  const upstream = parseJsoncObject(upstreamText, "Upstream wrangler.jsonc");
  const merged = clone(upstream);

  if (typeof current.name === "string" && current.name.trim()) {
    merged.name = current.name;
  }

  const vars = mergeVars(current.vars, upstream.vars);
  if (vars) {
    merged.vars = vars;
  } else {
    delete merged.vars;
  }

  if ("durable_objects" in upstream) {
    merged.durable_objects = mergeDurableObjects(current.durable_objects, upstream.durable_objects);
  }

  const kvNamespaces = mergeArrayByKey(current.kv_namespaces, upstream.kv_namespaces, "binding");
  if (kvNamespaces) merged.kv_namespaces = kvNamespaces;

  const r2Buckets = mergeArrayByKey(current.r2_buckets, upstream.r2_buckets, "binding");
  if (r2Buckets) merged.r2_buckets = r2Buckets;

  const containers = mergeArrayByKey(current.containers, upstream.containers, "class_name");
  if (containers) merged.containers = containers;

  return `${JSON.stringify(merged, null, "\t")}\n`;
}
