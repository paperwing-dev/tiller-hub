import { Hono } from "hono";
import { getArtifactStoreStub, getWorkspaceStub } from "../helpers";
import { getPlanArtifactById, loadRepoArtifacts, renderArtifactBodyMarkdown } from "../coordination";
import type { HonoEnv } from "../types";
import { loadEnvView } from "../env/view";
import { loadRepoForRequest } from "../repo/access";
import { isSafePath, areSafePaths } from "./validate";

const workspaceRoutes = new Hono<HonoEnv>();

workspaceRoutes.get("/api/workspace/:slug/manifest", async (c) => {
  const slug = c.req.param("slug");
  console.log(`[ws] GET /manifest ${slug}`);
  const stub = getWorkspaceStub(c.env, slug);
  const manifest = await stub.getManifest();
  console.log(`[ws] GET /manifest ${slug} -> ${manifest.length} files`);
  return c.json(manifest);
});

workspaceRoutes.get("/api/workspace/:slug/file", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query parameter is required" }, 400);
  if (!isSafePath(path)) return c.json({ error: "Path traversal not allowed" }, 400);

  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  const content = await stub.readWorkspaceFile(path);
  if (content === null) return c.json({ error: "File not found" }, 404);
  return c.text(content);
});

workspaceRoutes.post("/api/workspace/:slug/files", async (c) => {
  const body = await c.req.json<{ paths: string[] }>();
  if (!body.paths || !Array.isArray(body.paths)) {
    return c.json({ error: "paths array is required" }, 400);
  }
  if (!areSafePaths(body.paths)) return c.json({ error: "Path traversal not allowed" }, 400);

  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  const files = await stub.batchReadWorkspaceFiles(body.paths);
  return c.json({ files });
});

workspaceRoutes.post("/api/workspace/:slug/write", async (c) => {
  const body = await c.req.json<{ files: { path: string; content: string }[] }>();
  if (!body.files || !Array.isArray(body.files)) {
    return c.json({ error: "files array is required" }, 400);
  }
  if (!areSafePaths(body.files.map((f) => f.path))) return c.json({ error: "Path traversal not allowed" }, 400);

  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  await stub.writeWorkspaceFiles(body.files);
  return c.json({ ok: true, count: body.files.length });
});

workspaceRoutes.get("/api/workspace/:slug/deletions", async (c) => {
  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  return c.json({ paths: await stub.readGitHubDeletedWorkspacePaths() });
});

workspaceRoutes.put("/api/workspace/:slug/deletions", async (c) => {
  const body = await c.req.json<{ paths: string[] }>();
  if (!body.paths || !Array.isArray(body.paths)) {
    return c.json({ error: "paths array is required" }, 400);
  }
  if (!areSafePaths(body.paths)) return c.json({ error: "Path traversal not allowed" }, 400);

  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  await stub.replaceGitHubDeletedWorkspacePaths(body.paths);
  return c.json({ ok: true, count: body.paths.length });
});

workspaceRoutes.delete("/api/workspace/:slug/file", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query parameter is required" }, 400);
  if (!isSafePath(path)) return c.json({ error: "Path traversal not allowed" }, 400);

  const slug = c.req.param("slug");
  const stub = getWorkspaceStub(c.env, slug);
  const envMeta = await loadEnvView(c.env, slug);
  if (envMeta?.scmModel === "github") {
    await stub.deleteWorkspaceFiles([path], { trackGitHubDeletions: true });
    return c.json({ ok: true });
  }
  const deleted = await stub.deleteWorkspaceFile(path);
  if (!deleted) return c.json({ error: "File not found" }, 404);
  return c.json({ ok: true });
});

workspaceRoutes.post("/api/workspace/:slug/delete", async (c) => {
  const body = await c.req.json<{ paths: string[] }>();
  if (!body.paths || !Array.isArray(body.paths)) {
    return c.json({ error: "paths array is required" }, 400);
  }
  if (!areSafePaths(body.paths)) return c.json({ error: "Path traversal not allowed" }, 400);

  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  const envMeta = await loadEnvView(c.env, c.req.param("slug"));
  await stub.deleteWorkspaceFiles(body.paths, {
    trackGitHubDeletions: envMeta?.scmModel === "github",
  });
  return c.json({ ok: true, count: body.paths.length });
});

workspaceRoutes.get("/api/workspace/:slug/readdir", async (c) => {
  const dir = c.req.query("dir") || "/";
  if (!isSafePath(dir)) return c.json({ error: "Path traversal not allowed" }, 400);
  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  const entries = await stub.readWorkspaceDir(dir);
  return c.json(entries);
});

workspaceRoutes.get("/api/workspace/:slug/glob", async (c) => {
  const pattern = c.req.query("pattern");
  if (!pattern) return c.json({ error: "pattern query parameter is required" }, 400);
  if (!isSafePath(pattern)) return c.json({ error: "Path traversal not allowed" }, 400);

  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  const matches = await stub.globWorkspace(pattern);
  return c.json(matches);
});

workspaceRoutes.get("/api/workspace/:slug/info", async (c) => {
  const stub = getWorkspaceStub(c.env, c.req.param("slug"));
  const info = await stub.getWorkspaceInfo();
  return c.json(info);
});

workspaceRoutes.get("/api/workspace/:slug/download", async (c) => {
  const slug = c.req.param("slug");
  console.log(`[ws] GET /download ${slug}`);
  const stub = getWorkspaceStub(c.env, slug);
  const tarBuffer = await stub.downloadTar();
  console.log(`[ws] GET /download ${slug} -> ${tarBuffer.byteLength} bytes`);
  return new Response(tarBuffer, {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": "attachment; filename=workspace.tar",
    },
  });
});

workspaceRoutes.post("/api/workspace/:slug/init", async (c) => {
  return c.json({
    error: "Workspace initialization by repository URL is no longer supported. Add a GitHub App selected repository, then create an environment from its repoId.",
    code: "workspace_init_removed",
  }, 410);
});

async function materializePlanArtifact(c: any, id: string) {
  const slug = c.req.param("slug");
  const envMeta = await loadEnvView(c.env, slug);
  if (!envMeta) {
    return c.json({ error: "Workspace not found" }, 404);
  }
  const loadedRepo = await loadRepoForRequest(c.env, c.req.raw, envMeta.repoId);
  if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
  const repo = loadedRepo.repo;
  const targetWorkspace = getWorkspaceStub(c.env, slug);
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );

  try {
    const { artifacts } = await loadRepoArtifacts(artifactStore);
    const artifact = getPlanArtifactById(artifacts, id);
    if (!artifact) {
      return c.json({ error: "Plan artifact not found" }, 404);
    }

    const path = "/.tiller/plan.md";
    await targetWorkspace.writeWorkspaceFile(path, renderArtifactBodyMarkdown(artifact.body));
    return c.json({
      ok: true,
      path,
      artifact,
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to materialize plan artifact" },
      404,
    );
  }
}

workspaceRoutes.post("/api/workspace/:slug/artifacts/:id/plan", async (c) => {
  return materializePlanArtifact(c, c.req.param("id"));
});

export default workspaceRoutes;
