import { Hono, type Context } from "hono";
import type { HonoEnv, Env } from "../types";
import { getLocationHintOptions } from "../helpers";
import { parseCanonicalWorkersDevHostname } from "../canonical-workers-dev";
import {
  clearWorkersDevAccessTrustCache,
  readCanonicalWorkersDevAccessTrust,
} from "./records";
import type {
  PendingWorkersDevAccessJobV1,
  WorkersDevAccessCompletionResult,
  WorkersDevAccessJobAuthentication,
  WorkersDevAccessOperation,
  WorkersDevAccessTrustV1,
} from "./types";

const DEFAULT_BROKER_ORIGIN = "https://auth.paperwing.dev";
const MAX_BROKER_BODY_BYTES = 16 * 1_024;
const BROKER_REGISTRATION_TIMEOUT_MS = 10_000;
const MUTATION_DEADLINE_OFFSET_MS = 60 * 60 * 1_000;

class RequestBodyTooLargeError extends Error {}

class BrokerRegistrationError extends Error {
  constructor(readonly outcome: "definite_rejection" | "uncertain") {
    super("workers.dev Access broker registration failed");
  }
}

type WorkersDevAccessHubStore = {
  beginWorkersDevAccessJob(input: {
    operation: WorkersDevAccessOperation;
    origin: string;
    workerName: string;
  }): Promise<
    | { status: "created"; job: PendingWorkersDevAccessJobV1; jobSecret: string }
    | { status: "registering"; job: PendingWorkersDevAccessJobV1 }
    | { status: "existing"; job: PendingWorkersDevAccessJobV1 }
    | { status: "conflict"; job: PendingWorkersDevAccessJobV1 }
    | { status: "already_configured" }
    | { status: "not_configured" }
  >;
  cancelWorkersDevAccessJob(input: {
    jobId: string;
    jobSecretSha256: string;
  }): Promise<boolean>;
  markWorkersDevAccessJobRegistrationConfirmed(input: {
    jobId: string;
    jobSecretSha256: string;
  }): Promise<
    | { status: "confirmed" | "already_confirmed"; job: PendingWorkersDevAccessJobV1 }
    | { status: "stale" | "expired" }
  >;
  verifyWorkersDevAccessJobProof(
    input: WorkersDevAccessJobAuthentication & {
      intent: "bind" | "mutation_start";
    },
  ): Promise<{
    ok: true;
    registrationState: "registering" | "registered";
    completionDeadline: string;
    mutationState?: "started";
  } | { ok: false }>;
  completeWorkersDevAccessJob(input: WorkersDevAccessJobAuthentication & {
    result: WorkersDevAccessCompletionResult | unknown;
  }): Promise<{ status: "applied" | "already_applied" }>;
};

function getHub(env: Env): WorkersDevAccessHubStore {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as WorkersDevAccessHubStore;
}

function setNoStore(c: Context<HonoEnv>): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}

function brokerOrigin(env: Env): string {
  const configured = env.WORKERS_DEV_ACCESS_BROKER_URL?.trim() || DEFAULT_BROKER_ORIGIN;
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" || parsed.origin !== configured.replace(/\/+$/, "")) {
    throw new Error("workers.dev Access broker URL is invalid");
  }
  return parsed.origin;
}

function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

async function readBoundedBody(
  source: Pick<Request, "body" | "headers"> | Pick<Response, "body" | "headers">,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = source.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
  }
  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function assertBodylessSameOrigin(request: Request): Promise<void> {
  const origin = request.headers.get("Origin")?.trim() ?? "";
  if (!origin || origin !== requestOrigin(request)) {
    throw new Error("A same-origin browser request is required");
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase();
  if (fetchSite !== "same-origin") {
    throw new Error("A same-origin browser request is required");
  }
  try {
    await readBoundedBody(request, 0);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new Error("Request body is not supported");
    }
    throw error;
  }
}

function deriveWorkersDevTarget(urlInput: string): {
  origin: string;
  hostname: string;
  workerName: string;
} {
  const url = new URL(urlInput);
  if (url.protocol !== "https:") throw new Error("workers.dev setup requires HTTPS");
  const parsed = parseCanonicalWorkersDevHostname(url.hostname);
  return {
    origin: url.origin,
    hostname: parsed.hostname,
    workerName: parsed.serviceName,
  };
}

function jobMutationDeadline(job: PendingWorkersDevAccessJobV1): string {
  return new Date(Date.parse(job.completionDeadline) - MUTATION_DEADLINE_OFFSET_MS).toISOString();
}

function connectUrl(env: Env, jobId: string): string {
  return `${brokerOrigin(env)}/connect/${encodeURIComponent(jobId)}`;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const raw = new TextDecoder().decode(await readBoundedBody(request, MAX_BROKER_BODY_BYTES));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function readProofIntent(body: Record<string, unknown>): "bind" | "mutation_start" {
  if (body.intent !== "bind" && body.intent !== "mutation_start") {
    throw new Error("Invalid proof intent");
  }
  return body.intent;
}

function readJobAuthentication(body: Record<string, unknown>): WorkersDevAccessJobAuthentication {
  const operation = body.operation;
  if (operation !== "bootstrap" && operation !== "renew") {
    throw new Error("Invalid operation");
  }
  const read = (key: string, max = 2_048): string => {
    const value = body[key];
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new Error("Invalid job authentication");
    }
    return value.trim();
  };
  return {
    jobId: read("jobId", 128),
    jobSecret: read("jobSecret", 512),
    operation,
    origin: read("origin"),
    workerName: read("workerName", 512),
  };
}

async function registerCreatedJob(
  env: Env,
  args: {
    job: PendingWorkersDevAccessJobV1;
    jobSecret: string;
    hostname: string;
    renewal: WorkersDevAccessTrustV1 | null;
  },
): Promise<{ proofState: "proven" | "deferred" }> {
  const origin = brokerOrigin(env);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  let payload: unknown;
  try {
    timeout = setTimeout(() => controller.abort(), BROKER_REGISTRATION_TIMEOUT_MS);
    response = await fetch(`${origin}/v1/access/jobs`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        version: 1,
        jobId: args.job.jobId,
        jobSecret: args.jobSecret,
        operation: args.job.operation,
        origin: args.job.origin,
        workerName: args.job.workerName,
        workersDevHostname: args.hostname,
        mutationDeadline: jobMutationDeadline(args.job),
        completionDeadline: args.job.completionDeadline,
        ...(args.renewal
          ? {
              renewal: {
                ownerEmail: args.renewal.ownerEmail,
                accountId: args.renewal.accountId,
                serviceTokenId: args.renewal.serviceTokenId,
                serviceClientId: args.renewal.serviceClientId,
              },
            }
          : {}),
      }),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new BrokerRegistrationError("uncertain");
    }
    if (response.status >= 400 && response.status < 500) {
      throw new BrokerRegistrationError("definite_rejection");
    }
    if (!response.ok) throw new BrokerRegistrationError("uncertain");
    const raw = new TextDecoder().decode(
      await readBoundedBody(response, MAX_BROKER_BODY_BYTES),
    );
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof BrokerRegistrationError) throw error;
    throw new BrokerRegistrationError("uncertain");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.abort();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BrokerRegistrationError("uncertain");
  }
  const acknowledgement = payload as Record<string, unknown>;
  const acknowledgementKeys = Object.keys(acknowledgement).sort();
  const returnedConnectUrl = typeof acknowledgement.connectUrl === "string"
    ? acknowledgement.connectUrl.trim()
    : "";
  let parsedConnectUrl: URL | null = null;
  try {
    parsedConnectUrl = returnedConnectUrl ? new URL(returnedConnectUrl) : null;
  } catch {
    parsedConnectUrl = null;
  }
  if (
    acknowledgementKeys.length !== 3
    || acknowledgementKeys[0] !== "connectUrl"
    || acknowledgementKeys[1] !== "jobId"
    || acknowledgementKeys[2] !== "proofState"
    || acknowledgement.jobId !== args.job.jobId
    || !parsedConnectUrl
    || parsedConnectUrl.origin !== origin
    || parsedConnectUrl.username
    || parsedConnectUrl.password
    || parsedConnectUrl.pathname !== `/connect/${args.job.jobId}`
    || parsedConnectUrl.search
    || parsedConnectUrl.hash
    || (acknowledgement.proofState !== "proven" && acknowledgement.proofState !== "deferred")
    || (args.job.operation === "renew" && acknowledgement.proofState !== "proven")
  ) {
    throw new BrokerRegistrationError("uncertain");
  }
  return { proofState: acknowledgement.proofState };
}

async function startJob(
  c: Context<HonoEnv>,
  operation: WorkersDevAccessOperation,
): Promise<Response> {
  setNoStore(c);
  try {
    await assertBodylessSameOrigin(c.req.raw);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : "Invalid request",
      code: "same_origin_required",
    }, 403);
  }

  let target: ReturnType<typeof deriveWorkersDevTarget>;
  let renewal: WorkersDevAccessTrustV1 | null = null;
  try {
    if (operation === "bootstrap") {
      target = deriveWorkersDevTarget(c.req.url);
    } else {
      renewal = await readCanonicalWorkersDevAccessTrust(c.env);
      if (!renewal) throw new Error("workers.dev Access is not configured");
      target = deriveWorkersDevTarget(`https://${renewal.workersDevHostname}`);
    }
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : "workers.dev Access target is invalid",
      code: operation === "bootstrap" ? "invalid_workers_dev_target" : "access_not_configured",
    }, 409);
  }

  const hub = getHub(c.env);
  const started = await hub.beginWorkersDevAccessJob({
    operation,
    origin: target.origin,
    workerName: target.workerName,
  });
  if (started.status === "conflict") {
    return c.json({ error: "Another Cloudflare Access operation is already active.", code: "job_conflict" }, 409);
  }
  if (started.status === "already_configured") {
    return c.json({ error: "workers.dev Access is already configured.", code: "already_configured" }, 409);
  }
  if (started.status === "not_configured") {
    return c.json({ error: "workers.dev Access is not configured.", code: "access_not_configured" }, 409);
  }
  if (started.status !== "created" && started.status !== "existing") {
    if (started.status === "registering") {
      return c.json({
        error: "Cloudflare connection registration is still settling. Try again shortly.",
        code: "registration_pending",
        retryAt: started.job.registrationDeadline,
      }, 503);
    }
    return c.json({ error: "Cloudflare connection could not start.", code: "job_unavailable" }, 409);
  }

  if (started.status === "created") {
    try {
      await registerCreatedJob(c.env, {
        job: started.job,
        jobSecret: started.jobSecret,
        hostname: target.hostname,
        renewal,
      });
      const marked = await hub.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: started.job.jobId,
        jobSecretSha256: started.job.jobSecretSha256,
      });
      if (marked.status !== "confirmed" && marked.status !== "already_confirmed") {
        throw new BrokerRegistrationError("uncertain");
      }
    } catch (error) {
      const cancelled = await hub.cancelWorkersDevAccessJob({
        jobId: started.job.jobId,
        jobSecretSha256: started.job.jobSecretSha256,
      }).catch(() => false);
      if (error instanceof BrokerRegistrationError && error.outcome === "definite_rejection") {
        return c.json({
          error: "Cloudflare connection could not start. Try again.",
          code: "broker_rejected",
        }, 502);
      }
      if (cancelled) {
        return c.json({
          error: "Cloudflare connection could not start. Try again.",
          code: "broker_unavailable",
        }, 503);
      }
      return c.json({
        error: "Cloudflare connection registration is still settling. Try again shortly.",
        code: "registration_pending",
        retryAt: started.job.registrationDeadline,
      }, 503);
    }
  }

  return c.json({
    jobId: started.job.jobId,
    connectUrl: connectUrl(c.env, started.job.jobId),
    expiresAt: jobMutationDeadline(started.job),
  });
}

function completionPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Cloudflare connected</title>
  </head>
  <body>
    <p>Cloudflare Access is ready. Returning to Tiller…</p>
    <script>
      const storageKey = "tiller-cli-connect-v1";
      let hasCurrentCliRequest = false;
      try {
        const cliState = JSON.parse(sessionStorage.getItem(storageKey) || "null");
        const age = Date.now() - Number(cliState?.createdAt);
        hasCurrentCliRequest = Boolean(
          cliState
          && Number.isInteger(cliState.port)
          && cliState.port >= 1
          && cliState.port <= 65535
          && cliState.state
          && cliState.publicKeyJwk
          && Number.isFinite(age)
          && age >= 0
          && age <= 5 * 60 * 1000
        );
        if (!hasCurrentCliRequest) sessionStorage.removeItem(storageKey);
      } catch {
        sessionStorage.removeItem(storageKey);
      }
      window.location.replace(hasCurrentCliRequest ? "/cli/bootstrap?completed=1" : "/");
    </script>
  </body>
</html>`;
}

const workersDevAccessRoutes = new Hono<HonoEnv>();

workersDevAccessRoutes.post("/api/setup/workers-dev-access/oauth/start", (c) => {
  return startJob(c, "bootstrap");
});

workersDevAccessRoutes.post("/api/settings/workers-dev-access/oauth/start", (c) => {
  return startJob(c, "renew");
});

workersDevAccessRoutes.post("/api/setup/workers-dev-access/broker/proof", async (c) => {
  setNoStore(c);
  try {
    const body = await readBoundedJson(c.req.raw);
    const authentication = readJobAuthentication(body);
    const intent = readProofIntent(body);
    if (requestOrigin(c.req.raw) !== authentication.origin) throw new Error("Invalid origin");
    const authenticated = await getHub(c.env).verifyWorkersDevAccessJobProof(
      { ...authentication, intent },
    );
    if (!authenticated.ok) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      ok: true,
      registrationState: authenticated.registrationState,
      completionDeadline: authenticated.completionDeadline,
      ...(authenticated.mutationState ? { mutationState: authenticated.mutationState } : {}),
    });
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

workersDevAccessRoutes.post("/api/setup/workers-dev-access/broker/complete", async (c) => {
  setNoStore(c);
  try {
    const body = await readBoundedJson(c.req.raw);
    const authentication = readJobAuthentication(body);
    if (requestOrigin(c.req.raw) !== authentication.origin) throw new Error("Invalid origin");
    const completed = await getHub(c.env).completeWorkersDevAccessJob({
      ...authentication,
      result: body.result,
    });
    if (authentication.operation === "bootstrap") {
      clearWorkersDevAccessTrustCache(new URL(authentication.origin).hostname);
    }
    return c.json(completed);
  } catch {
    return c.json({ error: "Completion was rejected." }, 409);
  }
});

workersDevAccessRoutes.get("/setup/workers-dev-access/complete", (c) => {
  setNoStore(c);
  return c.html(completionPage());
});

export default workersDevAccessRoutes;
