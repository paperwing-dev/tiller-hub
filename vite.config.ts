import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { resolveBuildChannel } from "./scripts/build-channel.mjs";
import {
  parseDevelopmentSelfHostDeployRecord,
  validateManagedSelfHostRuntime,
} from "./scripts/self-host-runtime-build.mjs";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname);

function resolveModule(specifier: string): string {
  return require.resolve(specifier, { paths: [packageRoot] });
}

function readDevelopmentDeployRuntime(): { imageSourceId: string; sandboxImage: string } | null {
  const explicitImageSourceId = process.env.TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID?.trim() ?? "";
  const explicitSandboxImage = process.env.TILLER_SELF_HOST_RUNTIME_SANDBOX_IMAGE?.trim() ?? "";
  if (explicitImageSourceId || explicitSandboxImage) {
    const runtime = validateManagedSelfHostRuntime({
      imageSourceId: explicitImageSourceId,
      sandboxImage: explicitSandboxImage,
    }, "development machine runtime metadata");
    return runtime;
  }
  const recordPath = path.resolve(packageRoot, "../../.update-self-host-deploy-record.json");
  try {
    return parseDevelopmentSelfHostDeployRecord(
      JSON.parse(fs.readFileSync(recordPath, "utf8")),
    );
  } catch {
    return null;
  }
}

function buildChannel(command: "build" | "serve"): "development" | "release" {
  return command === "serve" ? "development" : resolveBuildChannel();
}

function readReleaseInfo(command: "build" | "serve"): unknown {
  const channel = buildChannel(command);
  const hubVersion = String(process.env.TILLER_BUILD_VERSION || require("./package.json").version).trim();
  const releaseId = process.env.TILLER_PUBLIC_RELEASE_ID?.trim() ?? "";
  const selfHostRuntimeImage = process.env.TILLER_SELF_HOST_RUNTIME_IMAGE?.trim() ?? "";
  if (releaseId && (!/^[0-9a-f]{40}$/.test(releaseId) || /^0{40}$/.test(releaseId))) {
    throw new Error("TILLER_PUBLIC_RELEASE_ID must be a nonzero 40-character lowercase public snapshot SHA.");
  }
  if (selfHostRuntimeImage
    && !/^docker\.io\/jamieatlason\/tiller-sandbox@sha256:[0-9a-f]{64}$/.test(selfHostRuntimeImage)) {
    throw new Error("TILLER_SELF_HOST_RUNTIME_IMAGE must be the digest-pinned Docker Hub sandbox image.");
  }
  if (process.env.TILLER_REQUIRE_RELEASE_INFO === "1") {
    if (channel !== "release" || !releaseId || !selfHostRuntimeImage) {
      throw new Error("Promoted release builds require a public release ID and digest-pinned self-host runtime image.");
    }
  }
  if (channel === "development"
    && process.env.TILLER_REQUIRE_SELF_HOST_RUNTIME === "1"
    && !readDevelopmentDeployRuntime()) {
    throw new Error("Development deployment requires an immutable validation runtime image.");
  }
  return {
    schemaVersion: 1,
    channel,
    hubVersion,
    ...(releaseId ? { releaseId } : {}),
    ...(selfHostRuntimeImage ? { selfHostRuntimeImage } : {}),
  };
}

export default defineConfig(({ command }) => ({
  build: {
    manifest: true,
  },
  define: {
    __TILLER_VERSION__: JSON.stringify(
      process.env.TILLER_BUILD_VERSION || require("./package.json").version,
    ),
    __TILLER_BUILD_CHANNEL__: JSON.stringify(buildChannel(command)),
    __TILLER_RELEASE_INFO__: JSON.stringify(readReleaseInfo(command)),
    __TILLER_DEVELOPMENT_RUNTIME__: JSON.stringify(
      buildChannel(command) === "development" ? readDevelopmentDeployRuntime() : null,
    ),
    __WORKERS_CI_COMMIT_SHA__: JSON.stringify(process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || ""),
    __WORKERS_CI_BRANCH__: JSON.stringify(process.env.WORKERS_CI_BRANCH || process.env.GITHUB_REF_NAME || ""),
  },
  plugins: [
    react(),
    cloudflare({
      configPath: path.join(packageRoot, command === "serve" ? "wrangler.dev.jsonc" : "wrangler.jsonc"),
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^agents$/,
        replacement: resolveModule("agents"),
      },
      {
        find: /^zod$/,
        replacement: resolveModule("zod"),
      },
      {
        find: /^zod\/v4$/,
        replacement: resolveModule("zod/v4"),
      },
      {
        find: /^zod\/v3$/,
        replacement: resolveModule("zod/v3"),
      },
      {
        find: /^mimetext$/,
        replacement: resolveModule("mimetext/browser"),
      },
    ],
  },
}));
