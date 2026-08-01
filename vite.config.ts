import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { resolveBuildChannel } from "./scripts/build-channel.mjs";
import {
  parseDevelopmentSelfHostDeployRecord,
  replaceSelfHostRuntimeMetadata,
  resolveSelfHostRuntimeChannel,
  resolveSelfHostRuntimeBuildInput,
  validateManagedSelfHostRuntime,
} from "./scripts/self-host-runtime-build.mjs";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname);

function resolveModule(specifier: string): string {
  return require.resolve(specifier, { paths: [packageRoot] });
}

function readDevelopmentDeployRuntime(): { imageSourceId: string; sandboxImage: string } | null {
  const recordPath = path.resolve(packageRoot, "../../.update-self-host-deploy-record.json");
  try {
    return parseDevelopmentSelfHostDeployRecord(
      JSON.parse(fs.readFileSync(recordPath, "utf8")),
    );
  } catch {
    return null;
  }
}

function readUpdateMetadata(command: "build" | "serve"): unknown {
  const metadataPath = path.join(packageRoot, "tiller-update.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }

  const sourceId = process.env.TILLER_UPDATE_SOURCE_ID?.trim();
  const buildChannel = resolveBuildChannel();
  const releaseImageSourceId = process.env.TILLER_RELEASE_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID?.trim() ?? "";
  const releaseSandboxImage = process.env.TILLER_RELEASE_SELF_HOST_RUNTIME_SANDBOX_IMAGE?.trim() ?? "";
  const releaseRuntime = releaseImageSourceId || releaseSandboxImage
    ? validateManagedSelfHostRuntime({
        imageSourceId: releaseImageSourceId,
        sandboxImage: releaseSandboxImage,
      }, "release machine runtime metadata")
    : null;
  if (releaseRuntime && (command === "serve" || buildChannel === "development")) {
    throw new Error("TILLER_RELEASE_SELF_HOST_RUNTIME_* is supported only for release builds.");
  }
  const selfHostRuntime = resolveSelfHostRuntimeBuildInput({
    env: process.env,
    buildChannel: resolveSelfHostRuntimeChannel(command, buildChannel),
    developmentRuntime: readDevelopmentDeployRuntime(),
    embeddedRuntime: releaseRuntime ?? ("selfHostRuntime" in metadata ? metadata.selfHostRuntime : null),
    required: process.env.TILLER_REQUIRE_SELF_HOST_RUNTIME === "1",
  });
  const resolvedMetadata = replaceSelfHostRuntimeMetadata(metadata, selfHostRuntime);
  if (!sourceId && !selfHostRuntime) {
    return resolvedMetadata;
  }

  const version = (process.env.TILLER_UPDATE_VERSION || process.env.TILLER_BUILD_VERSION || "").trim();
  const normalizedVersion = version.replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
  return {
    ...resolvedMetadata,
    ...(sourceId ? { sourceId } : {}),
    ...(normalizedVersion
      ? {
          version: normalizedVersion,
          label: `Tiller Hub v${normalizedVersion}`,
        }
      : {}),
    ...(selfHostRuntime ? { selfHostRuntime } : {}),
  };
}

export default defineConfig(({ command }) => ({
  define: {
    __TILLER_VERSION__: JSON.stringify(
      process.env.TILLER_BUILD_VERSION || require("./package.json").version,
    ),
    __TILLER_BUILD_CHANNEL__: JSON.stringify(resolveBuildChannel()),
    __TILLER_CURRENT_UPDATE__: JSON.stringify(readUpdateMetadata(command)),
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
