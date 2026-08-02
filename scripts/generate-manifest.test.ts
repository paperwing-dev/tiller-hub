import { afterEach, describe, expect, it } from "vitest";
import {
  buildManifestContainers,
  buildPlainTextBindings,
  resolveLegacyMigrations,
} from "./generate-manifest.mjs";

const envKeys = [
  "CONTAINER_IMAGE_TAG",
  "GITHUB_JOB_IMAGE_TAG",
  "TILLER_MANIFEST_REQUIRE_PINNED_IMAGES",
];

const previousEnv = new Map<string, string | undefined>();

function rememberEnv() {
  previousEnv.clear();
  for (const key of envKeys) {
    previousEnv.set(key, process.env[key]);
  }
}

function restoreEnv() {
  for (const [key, value] of previousEnv) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("generate-manifest container images", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("uses the same SHA-pinned image overrides as hub deploy", () => {
    rememberEnv();
    process.env.CONTAINER_IMAGE_TAG = "docker.io/jamieatlason/tiller-sandbox:abc123";
    process.env.GITHUB_JOB_IMAGE_TAG = "docker.io/jamieatlason/tiller-scm:abc123";
    process.env.TILLER_MANIFEST_REQUIRE_PINNED_IMAGES = "1";

    expect(buildManifestContainers({
      name: "tiller-hub",
      containers: [
        {
          class_name: "SandboxDO",
          name: "tiller-hub-sandbox",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 2,
          instance_type: "standard-1",
        },
        {
          class_name: "GitHubJobDO",
          name: "tiller-hub-github-job",
          image: "docker.io/jamieatlason/tiller-scm:stable",
          max_instances: 4,
          instance_type: "basic",
        },
        {
          class_name: "PlannerRunDO",
          name: "tiller-hub-planner-run",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 10,
          instance_type: "standard-1",
        },
        {
          class_name: "CodexAuthDO",
          name: "tiller-hub-codex-auth",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 1,
          instance_type: "basic",
        },
      ],
    })).toMatchObject([
      { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:abc123" },
      { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:abc123" },
      { class_name: "PlannerRunDO", image: "docker.io/jamieatlason/tiller-sandbox:abc123" },
      { class_name: "CodexAuthDO", image: "docker.io/jamieatlason/tiller-sandbox:abc123" },
    ]);
  });

  it("fails release manifest generation when a managed container remains stable", () => {
    rememberEnv();
    delete process.env.CONTAINER_IMAGE_TAG;
    delete process.env.GITHUB_JOB_IMAGE_TAG;
    process.env.TILLER_MANIFEST_REQUIRE_PINNED_IMAGES = "1";

    expect(() => buildManifestContainers({
      name: "tiller-hub",
      containers: [
        {
          class_name: "SandboxDO",
          name: "tiller-hub-sandbox",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 2,
          instance_type: "standard-1",
        },
        {
          class_name: "PlannerRunDO",
          name: "tiller-hub-planner-run",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 10,
          instance_type: "standard-1",
        },
        {
          class_name: "CodexAuthDO",
          name: "tiller-hub-codex-auth",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 1,
          instance_type: "basic",
        },
      ],
    })).toThrow(/must use a pinned image ref/);
  });
});

describe("generate-manifest plain text bindings", () => {
  it("does not require default harness enablement to be encoded as Worker config", () => {
    expect(buildPlainTextBindings({
      vars: {
        TILLER_REGION: "wnam",
      },
    })).toEqual([]);
  });

  it("uses the frozen migration history when the fresh config has only exports", () => {
    const frozen = [{ tag: "v1", new_sqlite_classes: ["HubDO"] }];
    expect(resolveLegacyMigrations({ exports: { HubDO: {} } }, frozen)).toEqual(frozen);
    expect(resolveLegacyMigrations({ migrations: [], exports: { HubDO: {} } }, frozen)).toEqual(frozen);
    expect(() => resolveLegacyMigrations({ exports: { HubDO: {} } }, [])).toThrow(/unavailable/);
  });
});
