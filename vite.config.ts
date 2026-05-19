import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname);

function resolveModule(specifier: string): string {
  return require.resolve(specifier, { paths: [packageRoot] });
}

export default defineConfig(({ command }) => ({
  define: {
    __TILLER_VERSION__: JSON.stringify(
      process.env.TILLER_BUILD_VERSION || require("./package.json").version,
    ),
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
    ],
  },
}));
