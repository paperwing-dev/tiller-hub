import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "../types";

const mocks = vi.hoisted(() => ({
  handleGitHubDraftPrPublishResult: vi.fn(),
}));

vi.mock("../github/env-publish-service", () => ({
  handleGitHubDraftPrPublishResult: mocks.handleGitHubDraftPrPublishResult,
  startGitHubDraftPrPublish: vi.fn(),
}));

import envRoutes from "../env/routes";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("GitHub publish result route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acknowledges the callback before background result processing finishes", async () => {
    const result = createDeferred<{ status: number; body: Record<string, unknown> }>();
    mocks.handleGitHubDraftPrPublishResult.mockReturnValueOnce(result.promise);
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };
    const app = new Hono<HonoEnv>();
    app.route("/", envRoutes);

    const response = await app.request(
      "/api/envs/demo-env/github/publish-draft-pr/publish-1/result",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callbackToken: "callback-token",
          workspaceHash: "workspace-hash",
          status: "published",
        }),
      },
      {} as HonoEnv["Bindings"],
      executionCtx as any,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, accepted: true });
    expect(mocks.handleGitHubDraftPrPublishResult).toHaveBeenCalledWith({
      env: {},
      slug: "demo-env",
      operationId: "publish-1",
      body: {
        callbackToken: "callback-token",
        workspaceHash: "workspace-hash",
        status: "published",
      },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);

    let processingFinished = false;
    const backgroundTask = executionCtx.waitUntil.mock.calls[0][0].then(() => {
      processingFinished = true;
    });
    await Promise.resolve();
    expect(processingFinished).toBe(false);

    result.resolve({ status: 200, body: { ok: true } });
    await backgroundTask;
    expect(processingFinished).toBe(true);
  });
});
