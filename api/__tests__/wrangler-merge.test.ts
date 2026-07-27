import { describe, expect, it } from "vitest";
import { mergeWranglerJsonc } from "../update/wrangler-merge";

describe("mergeWranglerJsonc", () => {
  it("preserves Worker identity, selected vars, and deploy-button resource identifiers", () => {
    const current = `{
      // Cloudflare deploy button mutates this name.
      "name": "adam-tiller",
      "vars": {
        "TILLER_REGION": "wnam",
        "HUB_PUBLIC_URL": "https://tiller.example.com",
        "WORKER_SERVICE_NAME": "adam-tiller",
        "TILLER_UPDATE_SERVICE_DISABLED": "1",
        "USER_DEFINED": "keep"
      },
      "compatibility_date": "2024-01-01",
      "durable_objects": {
        "bindings": [
          { "name": "HUB", "class_name": "HubDO", "script_name": "adam-tiller" }
        ]
      },
      "kv_namespaces": [
        { "binding": "ENVS_KV", "id": "kv-live" }
      ],
      "r2_buckets": [
        { "binding": "BUCKET", "bucket_name": "adam-tiller-bucket" }
      ],
      "containers": [
        { "class_name": "SandboxDO", "name": "adam-tiller-sandboxdo", "image": "old" }
      ],
      "workers_dev": false
    }`;

    const upstream = `{
      "name": "tiller-hub",
      "vars": {
        "TILLER_REGION": "weur",
        "HUB_PUBLIC_URL": "https://retired.preview.workers.dev",
        "WORKER_SERVICE_NAME": "retired-upstream-name",
        "ENABLED_ENV_HARNESSES": "claude-code,codex,opencode"
      },
      "compatibility_date": "2026-05-27",
      "compatibility_flags": ["nodejs_compat"],
      "durable_objects": {
        "bindings": [
          { "name": "HUB", "class_name": "HubDO" },
          { "name": "SANDBOX", "class_name": "SandboxDO" }
        ]
      },
      "kv_namespaces": [
        { "binding": "ENVS_KV" }
      ],
      "r2_buckets": [
        { "binding": "BUCKET" }
      ],
      "containers": [
        { "class_name": "SandboxDO", "name": "tiller-hub-sandboxdo", "image": "new" }
      ],
      "workers_dev": true,
      "preview_urls": false
    }`;

    const merged = JSON.parse(mergeWranglerJsonc(current, upstream));

    expect(merged.name).toBe("adam-tiller");
    expect(merged.compatibility_date).toBe("2026-05-27");
    expect(merged.workers_dev).toBe(true);
    expect(merged.preview_urls).toBe(false);
    expect(merged.vars).toMatchObject({
      TILLER_REGION: "wnam",
      TILLER_UPDATE_SERVICE_DISABLED: "1",
      USER_DEFINED: "keep",
      ENABLED_ENV_HARNESSES: "claude-code,codex,opencode",
    });
    expect(merged.vars).not.toHaveProperty("HUB_PUBLIC_URL");
    expect(merged.vars).not.toHaveProperty("WORKER_SERVICE_NAME");
    expect(merged.kv_namespaces[0]).toMatchObject({ binding: "ENVS_KV", id: "kv-live" });
    expect(merged.r2_buckets[0]).toMatchObject({ binding: "BUCKET", bucket_name: "adam-tiller-bucket" });
    expect(merged.durable_objects.bindings[0]).toMatchObject({ name: "HUB", script_name: "adam-tiller" });
    expect(merged.containers[0]).toMatchObject({
      class_name: "SandboxDO",
      name: "adam-tiller-sandboxdo",
      image: "new",
    });
  });
});
