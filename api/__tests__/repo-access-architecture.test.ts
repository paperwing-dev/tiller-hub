import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = new URL("..", import.meta.url);

async function listProductionApiFiles(dir = API_ROOT.pathname): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return [];
      return listProductionApiFiles(path);
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  }));
  return files.flat();
}

describe("repo access architecture", () => {
  it("does not expose legacy repo workspace lookup entrypoints in production code", async () => {
    const files = await listProductionApiFiles();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const rel = relative(API_ROOT.pathname, file);
      const bannedTokens = [
        "ensureRepoWorkspaceFromRepoUrl",
        "readRepoWorkspaceFromRepoUrl",
        "getGitHubAppValidatedRepoWorkspaceForRepoId",
        "resolveRequestGitHubRepoAccessPolicy",
        "GitHubRepoAccessPolicy",
        "loadSelectedRepo",
        "loadSelectedRepoForRequest",
        "loadStoredRepoForRequest",
        "loadStoredRepoForDeletion",
        "getRepoWorkspaceForEnvSlug",
        "getRepoPlanWorkspaceStub",
      ];
      for (const token of bannedTokens) {
        if (source.includes(token)) {
          violations.push(`${rel}: ${token}`);
        }
      }
      if (rel !== "plan/store.ts" && source.includes("getRepoWorkspaceForRepoId")) {
        if (rel !== "repo/access.ts") {
          violations.push(`${rel}: getRepoWorkspaceForRepoId`);
        }
      }
      if (
        rel !== "plan/store.ts" &&
        rel !== "repo/access.ts" &&
        source.includes("getSelectedRepoWorkspaceForRepoId")
      ) {
        violations.push(`${rel}: getSelectedRepoWorkspaceForRepoId`);
      }
      if (rel.endsWith("/routes.ts") && /\bloadRepo\s*\(/.test(source)) {
        violations.push(`${rel}: loadRepo`);
      }
      if (rel.endsWith("/routes.ts") && source.includes("getRepoPlanStoreKey")) {
        violations.push(`${rel}: getRepoPlanStoreKey`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps repo and env creation payloads repoId/App-selection based", async () => {
    const envRoutes = await readFile(new URL("../env/routes.ts", import.meta.url), "utf8");
    const repoRoutes = await readFile(new URL("../repo/routes.ts", import.meta.url), "utf8");

    const envCreateRoute = envRoutes.match(/envRoutes\.post\("\/api\/envs"[\s\S]*?\n}\);/)?.[0] ?? "";
    const repoCreateRoute = repoRoutes.match(/repoRoutes\.post\("\/api\/repos"[\s\S]*?\n}\);/)?.[0] ?? "";

    expect(envCreateRoute).not.toContain("repoUrl?:");
    expect(envCreateRoute).not.toContain("repoUrl is required");
    expect(repoCreateRoute).not.toContain("repoUrl?:");
    expect(repoCreateRoute).not.toContain("repoUrl is required");
    expect(repoCreateRoute).toContain("repositoryId");
    expect(repoCreateRoute).toContain("installationId");
    expect(repoCreateRoute).toContain("fullName");
  });

  it("keeps planner-owned state on tracked access while Settings retain live access", async () => {
    const plannerRoutes = await readFile(new URL("../planner/routes.ts", import.meta.url), "utf8");
    const repoRoutes = await readFile(new URL("../repo/routes.ts", import.meta.url), "utf8");

    expect(plannerRoutes).toContain("loadTrackedRepoForRequest");
    expect(plannerRoutes).not.toContain("loadRepoForRequest");

    for (const route of [
      'repoRoutes.get("/api/repos/:repoId/artifacts"',
      'repoRoutes.get("/api/repos/:repoId/artifacts/:id"',
      'repoRoutes.post("/api/repos/:repoId/plans"',
      'repoRoutes.patch("/api/repos/:repoId/artifacts/:id/status"',
      'repoRoutes.delete("/api/repos/:repoId/plans/:artifactId"',
      'repoRoutes.post("/api/repos/:repoId/artifacts"',
    ]) {
      const routeStart = repoRoutes.indexOf(route);
      expect(routeStart, route).toBeGreaterThanOrEqual(0);
      expect(repoRoutes.slice(routeStart, routeStart + 240), route).toContain("readTrackedRepoRouteContext");
    }

    for (const route of [
      'repoRoutes.get("/api/repos/:repoId/session-env"',
      'repoRoutes.get("/api/repos/:repoId/mcp-servers"',
    ]) {
      const routeStart = repoRoutes.indexOf(route);
      expect(routeStart, route).toBeGreaterThanOrEqual(0);
      expect(repoRoutes.slice(routeStart, routeStart + 240), route).toContain("readValidatedRepoRouteContext");
    }
  });

  it("keeps env summary cache readers out of production code", async () => {
    const files = await listProductionApiFiles();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const rel = relative(API_ROOT.pathname, file);
      for (const token of ["readEnvSummaryCache", "readEnvSummary", "readEnvMeta", "listEnvMetas"]) {
        if (source.includes(token)) {
          violations.push(`${rel}: ${token}`);
        }
      }
      for (const pattern of [
        /ENVS_KV\.get\(\s*slug\b/,
        /ENVS_KV\.get\(\s*meta\.slug\b/,
        /ENVS_KV\.get\(\s*env\.slug\b/,
      ]) {
        if (pattern.test(source)) {
          violations.push(`${rel}: ${pattern.source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps stored env definitions and summary cache rows free of repoUrl", async () => {
    const store = await readFile(new URL("../plan/store.ts", import.meta.url), "utf8");
    const definitionKeys = store.match(
      /const ENV_DEFINITION_KEYS = new Set<keyof EnvDefinition>\\(\\[[\\s\\S]*?\\]\\);/,
    )?.[0] ?? "";

    expect(store).toContain("const { repoUrl: _repoUrl, ...storedMeta } = meta;");
    expect(definitionKeys).not.toContain("repoUrl");
    expect(store).toContain("Object.keys(value).every");
    expect(store).toContain("JSON.stringify(definition)");
  });
});
