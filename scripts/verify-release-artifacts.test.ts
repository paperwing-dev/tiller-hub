import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReleaseBundleUrl,
  verifyPublishedRelease,
} from "../../../scripts/verify-release-artifacts.mjs";
import { INSTALLER_RUNTIME_BINDINGS } from "../../installer/src/release-contract";

const RELEASE_ID = "a".repeat(40);

describe("release artifact verification", () => {
  let directory: string;
  let descriptorPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(tmpdir(), "tiller-artifact-verification-"),
    );
    descriptorPath = path.join(directory, "release-descriptor.json");
    const bytes = Buffer.from("bundle");
    const descriptor = {
      schemaVersion: 1,
      releaseId: RELEASE_ID,
      version: "0.3.0",
      releaseNotesUrl:
        "https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v0.3.0",
      bundle: {
        url: "https://github.com/paperwing-dev/tiller-hub/releases/download/tiller-hub-v0.3.0/tiller-hub-v0.3.0.tar.gz",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      uploadTemplate: {
        mainModule: "index.js",
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        observability: { enabled: true, headSamplingRate: 1 },
        assets: { notFoundHandling: "single-page-application" },
        bindings: [
          { type: "durable_object_namespace", name: "HUB", className: "HubDO" },
          {
            type: "durable_object_namespace",
            name: "SANDBOX",
            className: "SandboxDO",
          },
          {
            type: "kv_namespace",
            name: "ENVS_KV",
            resourceSlot: "installation-kv",
          },
          {
            type: "r2_bucket",
            name: "BUCKET",
            resourceSlot: "installation-r2",
          },
          ...INSTALLER_RUNTIME_BINDINGS.map((binding) => ({ ...binding })),
        ],
        exports: {
          HubDO: { type: "durable-object", storage: "sqlite" },
          SandboxDO: { type: "durable-object", storage: "sqlite" },
        },
      },
      containers: [
        {
          className: "SandboxDO",
          applicationNameSuffix: "sandbox",
          image: `docker.io/example/tiller@sha256:${"c".repeat(64)}`,
          instanceType: "standard-1",
          maxInstances: 2,
        },
      ],
    };
    await writeFile(descriptorPath, JSON.stringify(descriptor));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("builds artifact URLs from the selected public mirror", () => {
    expect(canonicalReleaseBundleUrl("0.3.0", "example/release-mirror")).toBe(
      "https://github.com/example/release-mirror/releases/download/tiller-hub-v0.3.0/tiller-hub-v0.3.0.tar.gz",
    );
    expect(() => canonicalReleaseBundleUrl("0.3.0", "invalid")).toThrow(
      "owner/name",
    );
  });

  it("verifies the exact published bytes before installer deployment", async () => {
    const descriptorBytes = await readFile(descriptorPath);
    const fetchImpl = async (input: string | URL | Request) =>
      String(input).endsWith("release-descriptor.json")
        ? new Response(descriptorBytes, {
            headers: { "Content-Length": String(descriptorBytes.byteLength) },
          })
        : new Response("bundle", { headers: { "Content-Length": "6" } });
    await expect(
      verifyPublishedRelease({ descriptorPath, fetchImpl }),
    ).resolves.toMatchObject({
      descriptorUrl:
        "https://github.com/paperwing-dev/tiller-hub/releases/download/tiller-hub-v0.3.0/release-descriptor.json",
      size: 6,
      sha256: createHash("sha256").update("bundle").digest("hex"),
    });

    await expect(
      verifyPublishedRelease({
        descriptorPath,
        fetchImpl: async (input: string | URL | Request) =>
          String(input).endsWith("release-descriptor.json")
            ? new Response(descriptorBytes)
            : new Response("changed"),
      }),
    ).rejects.toThrow(/size|SHA-256/);
  });

  it("rejects a different published descriptor for the same source SHA", async () => {
    const published = JSON.parse(await readFile(descriptorPath, "utf8"));
    published.releaseNotesUrl = "https://example.test/redefined-release";
    const publishedBytes = Buffer.from(JSON.stringify(published));

    await expect(
      verifyPublishedRelease({
        descriptorPath,
        fetchImpl: async (input: string | URL | Request) =>
          String(input).endsWith("release-descriptor.json")
            ? new Response(publishedBytes)
            : new Response("bundle"),
      }),
    ).rejects.toThrow(/differs for public snapshot SHA.*immutable/);
  });
});
