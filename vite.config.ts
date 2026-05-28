import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname);

function resolveModule(specifier: string): string {
  return require.resolve(specifier, { paths: [packageRoot] });
}

function readUpdateMetadata(): unknown {
  const metadataPath = path.join(packageRoot, "tiller-update.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }

  const sourceId = process.env.TILLER_UPDATE_SOURCE_ID?.trim();
  if (!sourceId) {
    return metadata;
  }

  const version = (process.env.TILLER_UPDATE_VERSION || process.env.TILLER_BUILD_VERSION || "").trim();
  const normalizedVersion = version.replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
  return {
    ...metadata,
    sourceId,
    ...(normalizedVersion
      ? {
          version: normalizedVersion,
          label: `Tiller Hub v${normalizedVersion}`,
        }
      : {}),
  };
}

export default defineConfig(({ command }) => ({
  define: {
    __TILLER_VERSION__: JSON.stringify(
      process.env.TILLER_BUILD_VERSION || require("./package.json").version,
    ),
    __TILLER_CURRENT_UPDATE__: JSON.stringify(readUpdateMetadata()),
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
