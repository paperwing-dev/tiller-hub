import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const packageRoot = path.resolve(import.meta.dirname);
const require = createRequire(import.meta.url);

function resolveModule(specifier: string): string {
  return require.resolve(specifier, { paths: [packageRoot] });
}

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/ai-chat/react": resolveModule("@cloudflare/ai-chat/react"),
      "agents/react": resolveModule("agents/react"),
      agents: resolveModule("agents"),
      "cloudflare:workers": path.resolve(
        packageRoot,
        "test-support/cloudflare-workers.ts",
      ),
      zod: resolveModule("zod"),
      "zod/v4": resolveModule("zod/v4"),
      "zod/v3": resolveModule("zod/v3"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
  },
});
