import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import {
  clearWorkersDevAccessTrustCache,
} from "../workers-dev-access/records";
import workersDevAccessRoutes from "../workers-dev-access/routes";
import type {
  PendingWorkersDevAccessJobV1,
  WorkersDevAccessCredentialV1,
  WorkersDevAccessTrustV1,
} from "../workers-dev-access/types";

const job: PendingWorkersDevAccessJobV1 = {
  version: 1,
  jobId: "11111111-2222-4333-8444-555555555555",
  operation: "bootstrap",
  origin: "https://demo.preview.workers.dev",
  workerName: "demo",
  jobSecretSha256: "secret-hash",
  registrationState: "registered",
  registrationDeadline: "2026-07-16T20:02:00.000Z",
  registeredAt: "2026-07-16T20:00:01.000Z",
  completionDeadline: "2026-07-16T21:20:00.000Z",
};

const registeringJob: PendingWorkersDevAccessJobV1 = {
  ...job,
  registrationState: "registering",
  registeredAt: undefined,
};

const trust: WorkersDevAccessTrustV1 = {
  version: 1,
  ownerEmail: "owner@example.com",
  accountId: "account-1",
  workerName: "demo",
  workersDevHostname: "demo.preview.workers.dev",
  issuer: "https://team.cloudflareaccess.com",
  audience: "audience-1",
  serviceTokenId: "service-token-1",
  serviceClientId: "service-client.access",
  configuredAt: "2026-07-16T20:00:00.000Z",
};

const credential: WorkersDevAccessCredentialV1 = {
  version: 1,
  currentSecret: "service-secret",
  tokenExpiresAt: "2027-07-16T20:00:00.000Z",
  updatedAt: "2026-07-16T20:00:00.000Z",
};

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", workersDevAccessRoutes);
  return app;
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const store = {
    beginWorkersDevAccessJob: vi.fn(),
    cancelWorkersDevAccessJob: vi.fn(async () => true),
    markWorkersDevAccessJobRegistrationConfirmed: vi.fn(async () => ({
      status: "confirmed" as const,
      job,
    })),
    verifyWorkersDevAccessJobProof: vi.fn(),
    completeWorkersDevAccessJob: vi.fn(),
    getWorkersDevAccessTrust: vi.fn(async (hostname: string) => (
      hostname === trust.workersDevHostname ? trust : null
    )),
    getWorkersDevAccessCredential: vi.fn(async () => credential),
    getWorkersDevAccessLifecycle: vi.fn(async () => ({
      configured: true,
      workersDevHostname: trust.workersDevHostname,
      tokenExpiresAt: credential.tokenExpiresAt,
      renewalRecommended: false,
    })),
    ...overrides,
  };
  return {
    env: {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => store),
      },
    } as unknown as HonoEnv["Bindings"],
    store,
  };
}

function sameOriginHeaders(origin: string): Record<string, string> {
  return {
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  };
}

beforeEach(() => {
  clearWorkersDevAccessTrustCache();
  vi.unstubAllGlobals();
});

describe("workers.dev Access OAuth job routes", () => {
  it("ignores expired CLI continuation state on the bootstrap completion page", async () => {
    const response = await createApp().request(
      `${job.origin}/setup/workers-dev-access/complete`,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("age <= 5 * 60 * 1000");
    expect(html).toContain("sessionStorage.removeItem(storageKey)");
    expect(html).toContain("hasCurrentCliRequest ? \"/cli/bootstrap?completed=1\" : \"/\"");
  });

  it("requires a bodyless same-origin bootstrap request", async () => {
    const { env, store } = createEnv();
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "same_origin_required" });
    expect(store.beginWorkersDevAccessJob).not.toHaveBeenCalled();
  });

  it.each([
    "/api/setup/workers-dev-access/oauth/start",
    "/api/settings/workers-dev-access/oauth/start",
  ])("does not expose the legacy broker at %s to installer-managed Hubs", async (path) => {
    const { env, store } = createEnv();
    env.TILLER_INSTALLER_SCHEMA = "1";

    const response = await createApp().request(
      `${job.origin}${path}`,
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "installer_managed" });
    expect(store.beginWorkersDevAccessJob).not.toHaveBeenCalled();
  });

  it.each([
    "/api/setup/workers-dev-access/broker/proof",
    "/api/setup/workers-dev-access/broker/complete",
  ])("does not expose the legacy broker callback at %s to installer-managed Hubs", async (path) => {
    const { env, store } = createEnv();
    env.TILLER_INSTALLER_SCHEMA = "1";

    const response = await createApp().request(
      `${job.origin}${path}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env,
    );

    expect(response.status).toBe(404);
    expect(store.verifyWorkersDevAccessJobProof).not.toHaveBeenCalled();
    expect(store.completeWorkersDevAccessJob).not.toHaveBeenCalled();
  });

  it("rejects a streamed body on an otherwise valid OAuth-start request", async () => {
    const { env, store } = createEnv();
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      {
        method: "POST",
        headers: sameOriginHeaders(job.origin),
        body: "unexpected",
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "same_origin_required" });
    expect(store.beginWorkersDevAccessJob).not.toHaveBeenCalled();
  });

  it("registers the raw secret only with the broker and returns the 20-minute deadline", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    const brokerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const registration = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(registration).toMatchObject({
        version: 1,
        jobId: job.jobId,
        jobSecret: "raw-job-secret",
        operation: "bootstrap",
        origin: job.origin,
        workerName: job.workerName,
        workersDevHostname: "demo.preview.workers.dev",
        mutationDeadline: "2026-07-16T20:20:00.000Z",
        completionDeadline: job.completionDeadline,
      });
      expect(registration).not.toHaveProperty("renewal");
      return Response.json({
        jobId: job.jobId,
        connectUrl: `https://auth.paperwing.dev/connect/${job.jobId}`,
        proofState: "proven",
      });
    });
    vi.stubGlobal("fetch", brokerFetch);

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jobId: job.jobId,
      connectUrl: `https://auth.paperwing.dev/connect/${job.jobId}`,
      expiresAt: "2026-07-16T20:20:00.000Z",
    });
    expect(store.beginWorkersDevAccessJob).toHaveBeenCalledWith({
      operation: "bootstrap",
      origin: job.origin,
      workerName: job.workerName,
    });
    expect(brokerFetch).toHaveBeenCalledOnce();
    expect(store.markWorkersDevAccessJobRegistrationConfirmed).toHaveBeenCalledWith({
      jobId: job.jobId,
      jobSecretSha256: job.jobSecretSha256,
    });
  });

  it("accepts a strict deferred-proof acknowledgement for bootstrap", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      jobId: job.jobId,
      connectUrl: `https://auth.paperwing.dev/connect/${job.jobId}`,
      proofState: "deferred",
    })));

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(200);
    expect(store.markWorkersDevAccessJobRegistrationConfirmed).toHaveBeenCalledOnce();
  });

  it("clears the job when the Hub cannot confirm a successful broker acknowledgement", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    store.markWorkersDevAccessJobRegistrationConfirmed.mockResolvedValue({ status: "stale" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      jobId: job.jobId,
      connectUrl: `https://auth.paperwing.dev/connect/${job.jobId}`,
      proofState: "proven",
    })));

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cloudflare connection could not start. Try again.",
      code: "broker_unavailable",
    });
    expect(store.cancelWorkersDevAccessJob).toHaveBeenCalledWith({
      jobId: job.jobId,
      jobSecretSha256: job.jobSecretSha256,
    });
  });

  it("reuses an active job without extending or reregistering it", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({ status: "existing", job });
    const brokerFetch = vi.fn();
    vi.stubGlobal("fetch", brokerFetch);

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: job.jobId,
      expiresAt: "2026-07-16T20:20:00.000Z",
    });
    expect(brokerFetch).not.toHaveBeenCalled();
  });

  it("clears an uncertain registration so the user can retry immediately", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cloudflare connection could not start. Try again.",
      code: "broker_unavailable",
    });
    expect(store.cancelWorkersDevAccessJob).toHaveBeenCalledWith({
      jobId: job.jobId,
      jobSecretSha256: job.jobSecretSha256,
    });
    expect(store.markWorkersDevAccessJobRegistrationConfirmed).not.toHaveBeenCalled();
  });

  it("times out a stalled broker response and clears the job", async () => {
    vi.useFakeTimers();
    try {
      const { env, store } = createEnv();
      store.beginWorkersDevAccessJob.mockResolvedValue({
        status: "created",
        job: registeringJob,
        jobSecret: "raw-job-secret",
      });
      vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        })
      )));

      const responsePromise = createApp().request(
        "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
        { method: "POST", headers: sameOriginHeaders(job.origin) },
        env,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: "broker_unavailable" });
      expect(store.cancelWorkersDevAccessJob).toHaveBeenCalledWith({
        jobId: job.jobId,
        jobSecretSha256: job.jobSecretSha256,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an uncertain registration pending only when cancellation cannot be confirmed", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    store.cancelWorkersDevAccessJob.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cloudflare connection registration is still settling. Try again shortly.",
      code: "registration_pending",
      retryAt: registeringJob.registrationDeadline,
    });
  });

  it("returns a pending response without contacting the broker while registration settles", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "registering",
      job: registeringJob,
    });
    const brokerFetch = vi.fn();
    vi.stubGlobal("fetch", brokerFetch);

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "registration_pending",
      retryAt: registeringJob.registrationDeadline,
    });
    expect(brokerFetch).not.toHaveBeenCalled();
  });

  it("clears a definite broker rejection", async () => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "rejected" },
      { status: 409 },
    )));

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "broker_rejected" });
    expect(store.cancelWorkersDevAccessJob).toHaveBeenCalledWith({
      jobId: job.jobId,
      jobSecretSha256: job.jobSecretSha256,
    });
  });

  it.each([
    ["redirect", () => new Response(null, {
      status: 302,
      headers: { Location: "https://login.example.invalid" },
    })],
    ["server failure", () => new Response("failed", { status: 503 })],
    ["oversized declared response", () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(16 * 1_024 + 1) },
    })],
    ["oversized streamed response", () => new Response("x".repeat(16 * 1_024 + 1), {
      status: 200,
    })],
    ["invalid success", () => Response.json({ jobId: job.jobId })],
    ["success with unsupported fields", () => Response.json({
      jobId: job.jobId,
      connectUrl: `https://auth.paperwing.dev/connect/${job.jobId}`,
      proofState: "proven",
      receipt: "unsupported",
    })],
  ])("clears an uncertain %s registration outcome", async (_label, responseFactory) => {
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: registeringJob,
      jobSecret: "raw-job-secret",
    });
    vi.stubGlobal("fetch", vi.fn(async () => responseFactory()));

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders(job.origin) },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "broker_unavailable" });
    expect(store.cancelWorkersDevAccessJob).toHaveBeenCalledWith({
      jobId: job.jobId,
      jobSecretSha256: job.jobSecretSha256,
    });
  });

  it("binds renewal to canonical owner and Cloudflare resource metadata", async () => {
    const renewalJob = { ...job, operation: "renew" as const };
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: { ...renewalJob, registrationState: "registering", registeredAt: undefined },
      jobSecret: "raw-job-secret",
    });
    const brokerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operation: "renew",
        origin: job.origin,
        renewal: {
          ownerEmail: trust.ownerEmail,
          accountId: trust.accountId,
          serviceTokenId: trust.serviceTokenId,
          serviceClientId: trust.serviceClientId,
        },
      });
      return Response.json({
        jobId: job.jobId,
        connectUrl: `https://auth.paperwing.dev/connect/${job.jobId}`,
        proofState: "proven",
      });
    });
    vi.stubGlobal("fetch", brokerFetch);

    const response = await createApp().request(
      "https://tiller.example.com/api/settings/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders("https://tiller.example.com") },
      env,
    );

    expect(response.status).toBe(200);
    expect(store.beginWorkersDevAccessJob).toHaveBeenCalledWith({
      operation: "renew",
      origin: job.origin,
      workerName: job.workerName,
    });
  });

  it("does not confirm a renewal whose broker proof is deferred", async () => {
    const renewalJob: PendingWorkersDevAccessJobV1 = {
      ...registeringJob,
      operation: "renew",
    };
    const { env, store } = createEnv();
    store.beginWorkersDevAccessJob.mockResolvedValue({
      status: "created",
      job: renewalJob,
      jobSecret: "raw-job-secret",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      jobId: renewalJob.jobId,
      connectUrl: `https://auth.paperwing.dev/connect/${renewalJob.jobId}`,
      proofState: "deferred",
    })));

    const response = await createApp().request(
      "https://tiller.example.com/api/settings/workers-dev-access/oauth/start",
      { method: "POST", headers: sameOriginHeaders("https://tiller.example.com") },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "broker_unavailable" });
    expect(store.markWorkersDevAccessJobRegistrationConfirmed).not.toHaveBeenCalled();
    expect(store.cancelWorkersDevAccessJob).toHaveBeenCalledWith({
      jobId: renewalJob.jobId,
      jobSecretSha256: renewalJob.jobSecretSha256,
    });
  });

  it("authenticates broker proof and forwards completion without reflecting secrets", async () => {
    const { env, store } = createEnv();
    store.verifyWorkersDevAccessJobProof.mockResolvedValue({
      ok: true,
      registrationState: "registering",
      completionDeadline: job.completionDeadline,
    });
    store.completeWorkersDevAccessJob.mockResolvedValue({ status: "applied" });
    const authentication = {
      jobId: job.jobId,
      jobSecret: "raw-job-secret",
      operation: "bootstrap",
      origin: job.origin,
      workerName: job.workerName,
    };

    const proof = await createApp().request(
      `${job.origin}/api/setup/workers-dev-access/broker/proof`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...authentication, intent: "bind" }),
      },
      env,
    );
    expect(proof.status).toBe(200);
    await expect(proof.json()).resolves.toEqual({
      ok: true,
      registrationState: "registering",
      completionDeadline: job.completionDeadline,
    });
    expect(store.verifyWorkersDevAccessJobProof).toHaveBeenCalledWith({
      ...authentication,
      intent: "bind",
    });

    store.verifyWorkersDevAccessJobProof.mockResolvedValueOnce({
      ok: true,
      registrationState: "registered",
      completionDeadline: job.completionDeadline,
      mutationState: "started",
    });
    const mutationStart = await createApp().request(
      `${job.origin}/api/setup/workers-dev-access/broker/proof`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...authentication, intent: "mutation_start" }),
      },
      env,
    );
    expect(mutationStart.status).toBe(200);
    await expect(mutationStart.json()).resolves.toEqual({
      ok: true,
      registrationState: "registered",
      completionDeadline: job.completionDeadline,
      mutationState: "started",
    });

    const result = { trust: { version: 1 }, credential: { version: 1 } };
    const completion = await createApp().request(
      `${job.origin}/api/setup/workers-dev-access/broker/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...authentication, result }),
      },
      env,
    );
    expect(completion.status).toBe(200);
    const completionText = await completion.text();
    expect(JSON.parse(completionText)).toEqual({ status: "applied" });
    expect(store.completeWorkersDevAccessJob).toHaveBeenCalledWith({
      ...authentication,
      result,
    });
    expect(completionText).not.toContain("raw-job-secret");
  });

  it("rejects an oversized broker body before invoking the Hub", async () => {
    const { env, store } = createEnv();
    const response = await createApp().request(
      `${job.origin}/api/setup/workers-dev-access/broker/proof`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(16 * 1_024 + 1),
      },
      env,
    );

    expect(response.status).toBe(401);
    expect(store.verifyWorkersDevAccessJobProof).not.toHaveBeenCalled();
  });
});
