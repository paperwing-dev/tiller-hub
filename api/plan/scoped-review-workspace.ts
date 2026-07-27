import type { WorkspaceContextAccess } from "../agent-core/types";

const PROJECT_CONTEXT_PATHS = new Set(["/CLAUDE.md", "/.tiller/CLAUDE.md"]);
const ROOT_CONTEXT_PATHS = new Set([
  "/package.json",
  "/package-lock.json",
  "/pnpm-workspace.yaml",
  "/pnpm-lock.yaml",
  "/yarn.lock",
  "/lerna.json",
  "/turbo.json",
  "/nx.json",
  "/tsconfig.json",
  "/tsconfig.base.json",
  "/vite.config.ts",
  "/vite.config.js",
  "/vitest.config.ts",
  "/vitest.config.js",
  "/wrangler.jsonc",
  "/wrangler.toml",
]);
const ROOT_CONTEXT_PREFIXES = ["/configs", "/.github"];
const WORKSPACE_ROOT_SEGMENTS = new Set(["packages", "apps", "services", "workers", "libs"]);

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path.replace(/^\/+/, "")}`;
  }
  return path.replace(/\/+$/, "") || "/";
}

function parentDir(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function deriveWorkspaceRoot(path: string): string | null {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length >= 2 && WORKSPACE_ROOT_SEGMENTS.has(segments[0])) {
    return `/${segments[0]}/${segments[1]}`;
  }

  if (segments.length >= 1) {
    return `/${segments[0]}`;
  }

  return null;
}

function deriveScopedRoots(relevantFiles: string[]): string[] {
  const roots = relevantFiles
    .map((path) => normalizePath(path))
    .filter((path) => path.startsWith("/"))
    .flatMap((path) => [parentDir(path), deriveWorkspaceRoot(path)])
    .filter((path): path is string => Boolean(path) && path !== "/");

  return unique(roots);
}

function pathTouchesRoots(path: string, roots: string[]): boolean {
  const normalized = normalizePath(path);
  return roots.some((root) => {
    if (root === "/") return true;
    return (
      normalized === root ||
      normalized.startsWith(`${root}/`) ||
      root.startsWith(`${normalized}/`)
    );
  });
}

function pathTouchesProjectContext(path: string): boolean {
  const normalized = normalizePath(path);
  for (const contextPath of PROJECT_CONTEXT_PATHS) {
    if (normalized === contextPath || contextPath.startsWith(`${normalized}/`)) {
      return true;
    }
  }
  for (const contextPath of ROOT_CONTEXT_PATHS) {
    if (normalized === contextPath || contextPath.startsWith(`${normalized}/`)) {
      return true;
    }
  }
  for (const prefix of ROOT_CONTEXT_PREFIXES) {
    if (
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      prefix.startsWith(`${normalized}/`)
    ) {
      return true;
    }
  }
  return false;
}

export function createScopedReviewWorkspace(
  workspace: WorkspaceContextAccess,
  relevantFiles: string[],
): WorkspaceContextAccess {
  const scopedRoots = deriveScopedRoots(relevantFiles);
  if (scopedRoots.length === 0) {
    return workspace;
  }

  const isAllowedPath = (path: string): boolean => {
    const normalized = normalizePath(path);
    return pathTouchesProjectContext(normalized) || pathTouchesRoots(normalized, scopedRoots);
  };

  return {
    async readFile(path: string) {
      return isAllowedPath(path) ? workspace.readFile(path) : null;
    },
    writeFile(path: string, content: string) {
      return workspace.writeFile(path, content);
    },
    async readDir(path = "/") {
      const entries = await workspace.readDir(path);
      return entries.filter((entry) => isAllowedPath(entry.path));
    },
    async glob(pattern: string) {
      const entries = await workspace.glob(pattern);
      return entries.filter((entry) => isAllowedPath(entry.path));
    },
    getWorkspaceInfo() {
      return workspace.getWorkspaceInfo();
    },
  };
}
