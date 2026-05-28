import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";

const { partyMiddleware, partyserverMiddleware, routeAgentRequest } = vi.hoisted(() => ({
  partyMiddleware: vi.fn(async () => new Response("party ok")),
  partyserverMiddleware: vi.fn(() => vi.fn(async () => new Response("party ok"))),
  routeAgentRequest: vi.fn(async () => new Response("agent ok")),
}));

vi.mock("agents", () => ({
  Agent: class {},
  routeAgentRequest,
}));

vi.mock("@cloudflare/voice", () => ({
  withVoice: (Base: new (...args: never[]) => unknown) => Base,
  WorkersAIFluxSTT: class {},
  WorkersAITTS: class {},
}));

vi.mock("hono-party", () => ({
  partyserverMiddleware,
}));

vi.mock("partyserver", () => ({
  Server: class {},
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

vi.mock("../env-lifecycle-do", () => ({
  EnvLifecycleDO: class {},
}));

vi.mock("../coordination", () => ({
  ArtifactStoreDO: class {},
  loadRepoArtifacts: vi.fn(),
  renderArtifactBodyMarkdown: vi.fn(),
}));

vi.mock("../agents/plan-chat-agent", () => ({
  PlanChatAgent: class {},
}));

vi.mock("../agents/reviewer-chat-agent", () => ({
  ReviewerChatAgent: class {},
}));

vi.mock("../voice/agent", () => ({
  TillerVoice: class {},
}));

import worker from "../index";

function mockEnv(config: Record<string, string> = {}): Env {
  return {
    ...config,
    HUB: {
      idFromName: vi.fn(() => "hub"),
      get: vi.fn(() => ({
        getAllConfig: vi.fn(() => config),
        getConfig: vi.fn((key: string) => config[key] || undefined),
      })),
    },
  } as unknown as Env;
}

describe("Worker dynamic entrypoints", () => {
  beforeEach(() => {
    partyMiddleware.mockClear();
    partyserverMiddleware.mockClear();
    partyserverMiddleware.mockReturnValue(partyMiddleware);
    routeAgentRequest.mockClear();
  });

  it("blocks /agents before routeAgentRequest during protect-hub", async () => {
    const response = await worker.fetch(
      new Request("https://demo.preview.workers.dev/agents/plan-chat/default"),
      mockEnv({ HUB_PUBLIC_URL: "https://demo.preview.workers.dev" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    });
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it("requires Access auth on /agents after workers.dev Access is configured", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    const missing = await worker.fetch(
      new Request("https://demo.preview.workers.dev/agents/plan-chat/default"),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(401);
    expect(routeAgentRequest).not.toHaveBeenCalled();

    const authed = await worker.fetch(
      new Request("https://demo.preview.workers.dev/agents/plan-chat/default", {
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authed.status).toBe(200);
    await expect(authed.text()).resolves.toBe("agent ok");
    expect(routeAgentRequest).toHaveBeenCalledTimes(1);
  });

  it("blocks /parties before partyserver middleware during protect-hub", async () => {
    const response = await worker.fetch(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      mockEnv({ HUB_PUBLIC_URL: "https://demo.preview.workers.dev" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    });
    expect(partyserverMiddleware).not.toHaveBeenCalled();
    expect(partyMiddleware).not.toHaveBeenCalled();
  });

  it("requires Access auth on /parties after workers.dev Access is configured", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    const missing = await worker.fetch(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(401);
    expect(partyserverMiddleware).not.toHaveBeenCalled();
    expect(partyMiddleware).not.toHaveBeenCalled();

    const authed = await worker.fetch(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
          Upgrade: "websocket",
        },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authed.status).toBe(200);
    await expect(authed.text()).resolves.toBe("party ok");
    expect(partyserverMiddleware).toHaveBeenCalledTimes(1);
    expect(partyMiddleware).toHaveBeenCalledTimes(1);
  });
});
