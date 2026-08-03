import { Hono } from "hono";
import {
  parseSetExecutionBackendRequest,
  type LegacyCustomDomainCleanupManifestV1,
} from "../execution";
import type {
  Env,
  ExecutionStatus,
  HonoEnv,
  SetExecutionBackendRequest,
  SetExecutionBackendResult,
} from "../types";
import { inspectPredeployCleanSlate } from "../predeploy-clean-slate";
import { getDurableObjectStub } from "../durable-object";

interface ExecutionSettingsStore {
  getExecutionStatus(): Promise<ExecutionStatus>;
  setExecutionBackend(
    request: SetExecutionBackendRequest,
  ): Promise<SetExecutionBackendResult>;
  getLegacyCustomDomainCleanupManifest():
  Promise<LegacyCustomDomainCleanupManifestV1 | null>;
  getAllSessions(): Promise<import("../types").StoredSession[]>;
  getRoutableSessionIds(): Promise<string[]>;
}

function getStore(env: Env): ExecutionSettingsStore {
  return getDurableObjectStub<ExecutionSettingsStore>(env, env.HUB, "hub");
}

function noStore(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "no-store");
}

const routes = new Hono<HonoEnv>();

routes.get("/api/execution/status", async (c) => {
  noStore(c);
  return c.json(await getStore(c.env).getExecutionStatus());
});

routes.put("/api/settings/execution-backend", async (c) => {
  noStore(c);
  const body = await c.req.json().catch(() => null);
  const request = parseSetExecutionBackendRequest(body);
  if (!request) {
    return c.json({
      error: "Request must select Cloudflare or the exact currently detected machine.",
      code: "invalid_execution_backend_selection",
    }, 400);
  }
  const result = await getStore(c.env).setExecutionBackend(request);
  return result.ok ? c.json(result.status) : c.json(result, 409);
});

routes.get("/api/settings/legacy-custom-domain-cleanup", async (c) => {
  noStore(c);
  const manifest = await getStore(c.env).getLegacyCustomDomainCleanupManifest();
  if (!manifest) return c.json({ error: "Not found" }, 404);
  c.header(
    "Content-Disposition",
    'attachment; filename="tiller-legacy-custom-domain-cleanup-v1.json"',
  );
  return c.json(manifest);
});

routes.get("/api/settings/predeploy-clean-slate", async (c) => {
  noStore(c);
  const store = getStore(c.env);
  const [sessions, routableSessionIds] = await Promise.all([
    store.getAllSessions(),
    store.getRoutableSessionIds(),
  ]);
  const status = await inspectPredeployCleanSlate(c.env, {
    sessions,
    routableSessionIds,
  });
  return c.json(status, status.ok ? 200 : 409);
});

export default routes;
