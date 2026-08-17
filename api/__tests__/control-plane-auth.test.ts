import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticateWebSocketAuthorization,
  classifyRequestAuthorization,
  hubAuthGuardResponse,
} from "../auth";
import { mintEnvironmentRuntimeCapability } from "../env/runtime-capability";
import { mintPlanWriterRuntimeToken } from "../planner/runtime-token";
import type { Env, EnvLifecycleState } from "../types";
import {
  installedAccessBindings,
  TEST_WORKERS_DEV_HOSTNAME,
} from "./access-binding-fixture";
import { makeEnvDefinition } from "./fixtures/env";

const ISSUER = "https://control-plane-test.cloudflareaccess.com";
const AUDIENCE = "control-plane-audience";
const SERVICE_ID = "control-plane-service.access";
const OWNER_EMAIL = "owner@example.com";
const CONTROL_SECRET = "control-secret";
const RUNTIME_KEY = "runtime-key";
const ENV_SLUG = "env-1";
const INCARNATION_ID = "incarnation-1";
const START_OPERATION_ID = "start-op-1";

let privateKey: CryptoKey;

function lifecycle(
  overrides: Partial<EnvLifecycleState> = {},
): EnvLifecycleState {
  return {
    phase: "running",
    activeOpId: START_OPERATION_ID,
    activeOperation: "start",
    desiredState: "running",
    lastRunnerState: "running",
    lastWorkspaceSyncedAckOpId: null,
    infraState: "ready",
    runtimeReady: true,
    lastError: null,
    lastErrorAt: null,
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

function environmentRuntimeSubject(overrides: Record<string, unknown> = {}) {
  return {
    envSlug: ENV_SLUG,
    incarnationId: INCARNATION_ID,
    startOperationId: START_OPERATION_ID,
    lifecycle: lifecycle(),
    ...overrides,
  };
}

function envFor(
  subject = environmentRuntimeSubject(),
  publishOperation: {
    envSlug: string;
    operationId: string;
    callbackToken: string;
  } | null = null,
): Env {
  const lifecycleStub = {
    getEnvironmentRuntimeSubject: vi.fn(async () => subject),
    getGitHubPublishOperation: vi.fn(async () => publishOperation),
  };
  return {
    ...installedAccessBindings({
      hostname: TEST_WORKERS_DEV_HOSTNAME,
      issuer: ISSUER,
      audience: AUDIENCE,
      serviceClientId: SERVICE_ID,
      ownerEmail: OWNER_EMAIL,
    }),
    TILLER_CONTROL_SECRET: CONTROL_SECRET,
    TILLER_RUNTIME_CAPABILITY_KEY: RUNTIME_KEY,
    TILLER_PLANNER_RUNTIME_TOKEN_KEY: "plan-writer-key",
    HUB: {
      getByName: vi.fn(() => ({
        getAllConfig: vi.fn(async () => ({})),
        getConfig: vi.fn(async () => undefined),
      })),
    },
    ENVS_KV: {
      get: vi.fn(async () =>
        JSON.stringify(
          makeEnvDefinition({
            slug: ENV_SLUG,
            incarnationId: INCARNATION_ID,
          }),
        ),
      ),
    },
    ENV_LIFECYCLE: {
      getByName: vi.fn(() => lifecycleStub),
    },
  } as unknown as Env;
}

async function assertion(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "control-plane-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function ownerHeaders(
  extra: Record<string, string> = {},
): Promise<HeadersInit> {
  return {
    "Cf-Access-Jwt-Assertion": await assertion({
      email: OWNER_EMAIL,
      sub: "owner",
    }),
    ...extra,
  };
}

async function serviceHeaders(
  extra: Record<string, string> = {},
): Promise<HeadersInit> {
  return {
    "Cf-Access-Jwt-Assertion": await assertion({
      common_name: SERVICE_ID,
      sub: "",
    }),
    ...extra,
  };
}

function hubRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://${TEST_WORKERS_DEV_HOSTNAME}${path}`, init);
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "control-plane-key",
    alg: "RS256",
    use: "sig",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [jwk] })),
  );
});

describe("control-plane authorization classifier", () => {
  it("keeps only health and the exact GitHub webhook public", async () => {
    await expect(
      classifyRequestAuthorization(hubRequest("/health"), {} as Env),
    ).resolves.toEqual({ kind: "public" });
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/github/webhook", { method: "POST" }),
        {} as Env,
      ),
    ).resolves.toEqual({ kind: "public" });
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/github/webhook/extra", { method: "POST" }),
        envFor(),
      ),
    ).rejects.toThrow();
  });

  it("grants global authority only to owner or a valid control capability", async () => {
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/repos", {
          headers: await ownerHeaders(),
        }),
        envFor(),
      ),
    ).resolves.toMatchObject({ kind: "global", source: "owner" });

    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/repos", {
          headers: await serviceHeaders({
            "X-Tiller-Capability": CONTROL_SECRET,
          }),
        }),
        envFor(),
      ),
    ).resolves.toEqual({ kind: "global", source: "control" });

    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/repos", {
          headers: await serviceHeaders({ "X-Tiller-Capability": "wrong" }),
        }),
        envFor(),
      ),
    ).rejects.toThrow(/control or environment capability/i);
  });

  it("permits bare service identity only on exact bootstrap routes", async () => {
    for (const path of ["/api/update/check", "/api/installer/probe"]) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(path, {
            headers: await serviceHeaders(),
          }),
          envFor(),
        ),
      ).resolves.toEqual({ kind: "bootstrap" });
    }
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/update/check/extra", {
          headers: await serviceHeaders(),
        }),
        envFor(),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/planner-runtime/run-1", {
          headers: await serviceHeaders(),
        }),
        envFor(),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/planner-runtime/run-1", {
          headers: await serviceHeaders({
            "X-Tiller-Planner-Run-Token": "route-handler-will-verify",
          }),
        }),
        envFor(),
      ),
    ).rejects.toThrow();
  });

  it("retains global authority for control credentials on bootstrap routes", async () => {
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/update/check", {
          headers: await serviceHeaders({
            "X-Tiller-Capability": CONTROL_SECRET,
          }),
        }),
        envFor(),
      ),
    ).resolves.toEqual({ kind: "global", source: "control" });
  });

  it("scopes stopped-environment GitHub publishing to one recorded operation", async () => {
    const operation = {
      envSlug: ENV_SLUG,
      operationId: "publish-1",
      callbackToken: "publish-token-1",
    };
    const stopped = environmentRuntimeSubject({
      lifecycle: lifecycle({
        phase: "stopped",
        activeOperation: null,
        activeOpId: null,
      }),
    });
    const env = envFor(stopped, operation);
    const publishHeaders = await serviceHeaders({
      "X-Tiller-GitHub-Publish-Operation-Id": operation.operationId,
      "X-Tiller-GitHub-Publish-Token": operation.callbackToken,
    });

    for (const [method, path] of [
      ["GET", `/api/workspace/${ENV_SLUG}/download`],
      ["GET", `/api/workspace/${ENV_SLUG}/deletions`],
      [
        "POST",
        `/api/envs/${ENV_SLUG}/github/publish-draft-pr/${operation.operationId}/result`,
      ],
    ] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(path, {
            method,
            headers: publishHeaders,
          }),
          env,
        ),
      ).resolves.toEqual({ kind: "specialized" });
    }

    for (const request of [
      hubRequest(`/api/workspace/${ENV_SLUG}/download`, {
        headers: await serviceHeaders({
          "X-Tiller-GitHub-Publish-Operation-Id": operation.operationId,
          "X-Tiller-GitHub-Publish-Token": "wrong-token",
        }),
      }),
      hubRequest(`/api/workspace/other-env/download`, {
        headers: publishHeaders,
      }),
      hubRequest(
        `/api/envs/${ENV_SLUG}/github/publish-draft-pr/other-operation/result`,
        {
          method: "POST",
          headers: publishHeaders,
        },
      ),
      hubRequest(`/api/workspace/${ENV_SLUG}/manifest`, {
        headers: publishHeaders,
      }),
    ]) {
      await expect(
        classifyRequestAuthorization(request, env),
      ).rejects.toThrow();
    }
  });

  it("defaults unknown API routes to global authority", async () => {
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/future-control-route", {
          method: "POST",
          headers: await serviceHeaders(),
        }),
        envFor(),
      ),
    ).rejects.toThrow(/control or environment capability/i);
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/future-control-route", {
          method: "POST",
          headers: await ownerHeaders({
            Origin: `https://${TEST_WORKERS_DEV_HOSTNAME}`,
          }),
        }),
        envFor(),
      ),
    ).resolves.toMatchObject({ kind: "global", source: "owner" });
  });

  it.each([null, "null", "not-an-origin", "https://cross-site.example"])(
    "rejects unsafe owner requests with origin %s",
    async (origin) => {
      const extra: Record<string, string> =
        origin === null ? {} : { Origin: origin };
      await expect(
        classifyRequestAuthorization(
          hubRequest("/api/repos", {
            method: "POST",
            headers: await ownerHeaders(extra),
          }),
          envFor(),
        ),
      ).rejects.toThrow(/origin/i);
    },
  );

  it("accepts the exact owner origin and does not apply browser origin rules to control clients", async () => {
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/repos", {
          method: "POST",
          headers: await ownerHeaders({
            Origin: `https://${TEST_WORKERS_DEV_HOSTNAME}`,
          }),
        }),
        envFor(),
      ),
    ).resolves.toMatchObject({ kind: "global", source: "owner" });
    await expect(
      classifyRequestAuthorization(
        hubRequest("/api/repos", {
          method: "POST",
          headers: await serviceHeaders({
            "X-Tiller-Capability": CONTROL_SECRET,
          }),
        }),
        envFor(),
      ),
    ).resolves.toEqual({ kind: "global", source: "control" });
  });

  it("allows no-origin local CLI calls but requires the configured local browser origin", async () => {
    const local = {
      LOCAL_DEV_ONLY_BACKEND: "1",
      TILLER_LOCAL_DEV_ORIGIN: "http://localhost:5173",
    } as Env;
    await expect(
      classifyRequestAuthorization(
        new Request("http://localhost:8787/api/repos", {
          method: "POST",
        }),
        local,
      ),
    ).resolves.toEqual({ kind: "global", source: "local-dev" });
    await expect(
      classifyRequestAuthorization(
        new Request("http://localhost:8787/api/repos", {
          method: "POST",
          headers: { Origin: "http://localhost:5173" },
        }),
        local,
      ),
    ).resolves.toEqual({ kind: "global", source: "local-dev" });
    await expect(
      classifyRequestAuthorization(
        new Request("http://localhost:8787/api/repos", {
          method: "POST",
          headers: { Origin: "http://localhost:8787" },
        }),
        local,
      ),
    ).rejects.toThrow(/origin/i);
  });

  it("fails closed when production Access trust is absent", async () => {
    const response = await hubAuthGuardResponse(hubRequest("/api/repos"), {
      HUB: { getByName: vi.fn(() => ({})) },
    } as unknown as Env);
    expect(response?.status).toBe(403);
  });
});

describe("environment runtime capability classification", () => {
  it("demonstrates that credentials copied from a container cannot enter the control plane", async () => {
    const env = envFor();
    const capability = await mintEnvironmentRuntimeCapability(env, {
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });
    const headers = await serviceHeaders({ "X-Tiller-Capability": capability });
    for (const [method, path] of [
      ["POST", "/api/machines"],
      ["GET", "/api/repos"],
      ["POST", "/api/envs/other-env/sessions"],
      ["POST", `/api/envs/${ENV_SLUG}/start`],
    ] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(path, { method, headers }),
          env,
        ),
      ).rejects.toThrow();
    }
  });

  it("binds the capability to the current slug, incarnation, and start operation", async () => {
    const env = envFor();
    const capability = await mintEnvironmentRuntimeCapability(env, {
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/sessions`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        env,
      ),
    ).resolves.toEqual({
      kind: "environment",
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });

    for (const [method, path] of [
      ["GET", `/api/envs/${ENV_SLUG}/sessions/session-1`],
      ["POST", `/api/envs/${ENV_SLUG}/sessions/session-1/permissions`],
      [
        "GET",
        `/api/envs/${ENV_SLUG}/sessions/session-1/permissions/permission-1`,
      ],
    ] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(path, {
            method,
            headers: await serviceHeaders({
              "X-Tiller-Capability": capability,
            }),
          }),
          env,
        ),
      ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    }

    for (const [method, suffix] of [
      ["GET", "manifest"],
      ["GET", "file"],
      ["POST", "files"],
      ["POST", "write"],
      ["GET", "deletions"],
      ["PUT", "deletions"],
      ["DELETE", "file"],
      ["POST", "delete"],
      ["GET", "readdir"],
      ["GET", "glob"],
      ["GET", "info"],
      ["GET", "download"],
    ] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(`/api/workspace/${ENV_SLUG}/${suffix}`, {
            method,
            headers: await serviceHeaders({
              "X-Tiller-Capability": capability,
            }),
          }),
          env,
        ),
      ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    }

    for (const [method, suffix] of [
      ["GET", "future-control"],
      ["POST", "manifest"],
      ["POST", "init"],
      ["POST", "artifacts/artifact-1/plan"],
    ] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(`/api/workspace/${ENV_SLUG}/${suffix}`, {
            method,
            headers: await serviceHeaders({
              "X-Tiller-Capability": capability,
            }),
          }),
          env,
        ),
      ).rejects.toThrow();
    }

    for (const [label, subject] of [
      [
        "slug",
        {
          envSlug: "other-env",
          incarnationId: INCARNATION_ID,
          startOperationId: START_OPERATION_ID,
        },
      ],
      [
        "incarnation",
        {
          envSlug: ENV_SLUG,
          incarnationId: "other-incarnation",
          startOperationId: START_OPERATION_ID,
        },
      ],
      [
        "operation",
        {
          envSlug: ENV_SLUG,
          incarnationId: INCARNATION_ID,
          startOperationId: "other-start",
        },
      ],
    ] as const) {
      const wrong = await mintEnvironmentRuntimeCapability(env, subject);
      await expect(
        classifyRequestAuthorization(
          hubRequest(`/api/envs/${ENV_SLUG}/sessions`, {
            method: "POST",
            headers: await serviceHeaders({ "X-Tiller-Capability": wrong }),
          }),
          env,
        ),
        label,
      ).rejects.toThrow();
    }
  });

  it("does not read the global control secret for a valid environment capability", async () => {
    const env = envFor();
    delete (env as unknown as Record<string, unknown>).TILLER_CONTROL_SECRET;
    const capability = await mintEnvironmentRuntimeCapability(env, {
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });

    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/workspace/${ENV_SLUG}/manifest`, {
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        env,
      ),
    ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    expect((env.HUB as any).getByName).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures, disallowed route families, and inactive lifecycle state", async () => {
    const capability = await mintEnvironmentRuntimeCapability(envFor(), {
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/sessions`, {
          method: "POST",
          headers: await serviceHeaders({
            "X-Tiller-Capability": `${capability}0`,
          }),
        }),
        envFor(),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/start`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor(),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(
          `/api/envs/${ENV_SLUG}/github/publish-draft-pr/publish-1/result`,
          {
            method: "POST",
            headers: await serviceHeaders({
              "X-Tiller-Capability": capability,
            }),
          },
        ),
        envFor(),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/sessions`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor(
          environmentRuntimeSubject({
            lifecycle: lifecycle({
              phase: "stopped",
              activeOperation: null,
              activeOpId: null,
            }),
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("allows only finalization routes for the same stopping incarnation", async () => {
    const subject = environmentRuntimeSubject({
      lifecycle: lifecycle({
        phase: "stopping",
        activeOperation: "stop",
        activeOpId: "stop-op-1",
      }),
    });
    const env = envFor(subject);
    const capability = await mintEnvironmentRuntimeCapability(env, {
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });
    for (const suffix of ["stop", "runner-stopped"] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(`/api/envs/${ENV_SLUG}/${suffix}`, {
            method: "POST",
            headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
          }),
          env,
        ),
      ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    }
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/workspace/${ENV_SLUG}/manifest`, {
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        env,
      ),
    ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/workspace/${ENV_SLUG}/download`, {
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        env,
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/sessions`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        env,
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/runner-stopped`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor({ ...subject, incarnationId: "new-incarnation" }),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/runner-stopped`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor({
          ...subject,
          lifecycle: lifecycle({
            phase: "failed",
            activeOperation: "stop",
            activeOpId: "stop-op-1",
          }),
        }),
      ),
    ).rejects.toThrow();

    const failedRetrySubject = environmentRuntimeSubject({
      lifecycle: lifecycle({
        phase: "failed",
        activeOperation: "stop",
        activeOpId: "stop-op-1",
        infraState: "ready",
      }),
      failedStopFinalizationAuthorized: true,
    });
    for (const [method, path] of [
      ["POST", `/api/envs/${ENV_SLUG}/workspace-synced`],
      ["POST", `/api/envs/${ENV_SLUG}/stop-failed`],
      ["POST", `/api/workspace/${ENV_SLUG}/write`],
    ] as const) {
      await expect(
        classifyRequestAuthorization(
          hubRequest(path, {
            method,
            headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
          }),
          envFor(failedRetrySubject),
        ),
      ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    }
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/sessions`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor(failedRetrySubject),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/workspace-synced`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor({
          ...failedRetrySubject,
          failedStopFinalizationAuthorized: false,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      classifyRequestAuthorization(
        hubRequest(`/api/envs/${ENV_SLUG}/workspace-synced`, {
          method: "POST",
          headers: await serviceHeaders({ "X-Tiller-Capability": capability }),
        }),
        envFor({
          ...failedRetrySubject,
          lifecycle: lifecycle({
            phase: "failed",
            activeOperation: "stop",
            activeOpId: "stop-op-1",
            infraState: "stopped",
          }),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("WebSocket authority classification", () => {
  it("requires exact owner origin and allows no-origin control clients", async () => {
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest("/parties/hub/hub", {
          headers: await ownerHeaders({
            Upgrade: "websocket",
            Origin: `https://${TEST_WORKERS_DEV_HOSTNAME}`,
          }),
        }),
        envFor(),
      ),
    ).resolves.toMatchObject({ kind: "global", source: "owner" });
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest("/parties/hub/hub", {
          headers: await ownerHeaders({ Upgrade: "websocket" }),
        }),
        envFor(),
      ),
    ).rejects.toThrow(/origin/i);
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest("/parties/hub/hub", {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Capability": CONTROL_SECRET,
          }),
        }),
        envFor(),
      ),
    ).resolves.toEqual({ kind: "global", source: "control" });
  });

  it.each([null, "null", "not-an-origin", "https://cross-site.example"])(
    "rejects owner WebSockets with origin %s",
    async (origin) => {
      await expect(
        authenticateWebSocketAuthorization(
          hubRequest("/parties/hub/hub", {
            headers: await ownerHeaders({
              Upgrade: "websocket",
              ...(origin === null ? {} : { Origin: origin }),
            }),
          }),
          envFor(),
        ),
      ).rejects.toThrow(/origin/i);
    },
  );

  it("classifies local-development sockets and rejects bad control credentials", async () => {
    const local = {
      LOCAL_DEV_ONLY_BACKEND: "1",
      TILLER_LOCAL_DEV_ORIGIN: "http://localhost:5173",
    } as Env;
    for (const headers of [
      { Upgrade: "websocket" },
      { Upgrade: "websocket", Origin: "http://localhost:5173" },
    ]) {
      await expect(
        authenticateWebSocketAuthorization(
          new Request("http://localhost:8787/parties/hub/hub", { headers }),
          local,
        ),
      ).resolves.toEqual({ kind: "global", source: "local-dev" });
    }
    await expect(
      authenticateWebSocketAuthorization(
        new Request("http://localhost:8787/parties/hub/hub", {
          headers: {
            Upgrade: "websocket",
            Origin: "http://localhost:8787",
          },
        }),
        local,
      ),
    ).rejects.toThrow(/origin/i);
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest("/parties/hub/hub", {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Capability": "wrong-control-secret",
          }),
        }),
        envFor(),
      ),
    ).rejects.toThrow(/scoped runtime or control/i);
  });

  it("rejects bare service sockets and binds runtime selectors into environment authority", async () => {
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest("/parties/hub/hub", {
          headers: await serviceHeaders({ Upgrade: "websocket" }),
        }),
        envFor(),
      ),
    ).rejects.toThrow(/scoped runtime or control/i);

    const env = envFor();
    const capability = await mintEnvironmentRuntimeCapability(env, {
      envSlug: ENV_SLUG,
      incarnationId: INCARNATION_ID,
      startOperationId: START_OPERATION_ID,
    });
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest(`/parties/hub/hub?envSlug=${ENV_SLUG}&sessionId=session-1`, {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Capability": capability,
          }),
        }),
        env,
      ),
    ).resolves.toEqual({
      kind: "environment",
      envSlug: ENV_SLUG,
      sessionId: "session-1",
    });

    const persistedControlEnv = envFor();
    delete (persistedControlEnv as unknown as Record<string, unknown>).TILLER_CONTROL_SECRET;
    const persistedControlCapability = await mintEnvironmentRuntimeCapability(
      persistedControlEnv,
      {
        envSlug: ENV_SLUG,
        incarnationId: INCARNATION_ID,
        startOperationId: START_OPERATION_ID,
      },
    );
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest(`/parties/hub/hub?envSlug=${ENV_SLUG}&sessionId=session-1`, {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Capability": persistedControlCapability,
          }),
        }),
        persistedControlEnv,
      ),
    ).resolves.toMatchObject({ kind: "environment", envSlug: ENV_SLUG });
    expect((persistedControlEnv.HUB as any).getByName).not.toHaveBeenCalled();

    await expect(
      authenticateWebSocketAuthorization(
        hubRequest(
          `/api/voice/session?envSlug=${ENV_SLUG}&sessionId=session-1`,
          {
            headers: await serviceHeaders({
              Upgrade: "websocket",
              "X-Tiller-Capability": capability,
            }),
          },
        ),
        env,
      ),
    ).rejects.toThrow(/limited to the Hub endpoint/i);

    for (const [label, path, candidateEnv, candidateCapability] of [
      [
        "missing environment",
        "/parties/hub/hub?sessionId=session-1",
        env,
        capability,
      ],
      [
        "missing session",
        `/parties/hub/hub?envSlug=${ENV_SLUG}`,
        env,
        capability,
      ],
      [
        "wrong environment",
        "/parties/hub/hub?envSlug=other-env&sessionId=session-1",
        env,
        capability,
      ],
      [
        "wrong capability",
        `/parties/hub/hub?envSlug=${ENV_SLUG}&sessionId=session-1`,
        env,
        `${capability}0`,
      ],
      [
        "stopped environment",
        `/parties/hub/hub?envSlug=${ENV_SLUG}&sessionId=session-1`,
        envFor(
          environmentRuntimeSubject({
            lifecycle: lifecycle({
              phase: "stopped",
              activeOperation: null,
              activeOpId: null,
            }),
          }),
        ),
        capability,
      ],
    ] as const) {
      await expect(
        authenticateWebSocketAuthorization(
          hubRequest(path, {
            headers: await serviceHeaders({
              Upgrade: "websocket",
              "X-Tiller-Capability": candidateCapability,
            }),
          }),
          candidateEnv,
        ),
        label,
      ).rejects.toThrow();
    }
  });

  it("keeps plan-writer sockets on their existing exact token scope", async () => {
    const env = envFor();
    const token = await mintPlanWriterRuntimeToken(env, "repo-1", "plan-1", 2);
    const path =
      "/parties/hub/hub?repoId=repo-1&planArtifactId=plan-1&generation=2&sessionId=writer-1";
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest(path, {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Plan-Writer-Token": token,
          }),
        }),
        env,
      ),
    ).resolves.toEqual({
      kind: "planWriter",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      generation: 2,
      sessionId: "writer-1",
    });
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest(path, {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Capability": CONTROL_SECRET,
            "X-Tiller-Plan-Writer-Token": token,
          }),
        }),
        env,
      ),
    ).resolves.toEqual({ kind: "global", source: "control" });
    await expect(
      authenticateWebSocketAuthorization(
        hubRequest(path.replace("generation=2", "generation=3"), {
          headers: await serviceHeaders({
            Upgrade: "websocket",
            "X-Tiller-Plan-Writer-Token": token,
          }),
        }),
        env,
      ),
    ).rejects.toThrow(/scoped runtime or control/i);

    for (const [label, candidatePath, candidateToken] of [
      ["missing repository", path.replace("repoId=repo-1&", ""), token],
      [
        "missing artifact",
        path.replace("planArtifactId=plan-1&", ""),
        token,
      ],
      ["missing generation", path.replace("generation=2&", ""), token],
      ["missing session", path.replace("&sessionId=writer-1", ""), token],
      ["wrong repository", path.replace("repoId=repo-1", "repoId=repo-2"), token],
      [
        "wrong artifact",
        path.replace("planArtifactId=plan-1", "planArtifactId=plan-2"),
        token,
      ],
      ["wrong generation", path.replace("generation=2", "generation=3"), token],
      ["wrong token", path, `${token}0`],
      ["missing token", path, ""],
    ] as const) {
      await expect(
        authenticateWebSocketAuthorization(
          hubRequest(candidatePath, {
            headers: await serviceHeaders({
              Upgrade: "websocket",
              ...(candidateToken
                ? { "X-Tiller-Plan-Writer-Token": candidateToken }
                : {}),
            }),
          }),
          env,
        ),
        label,
      ).rejects.toThrow(/scoped runtime or control/i);
    }
  });
});
