import { describe, expect, it } from "vitest";

import {
  canonicalIngressResponse,
  parseCanonicalWorkersDevHostname,
  workersDevOrigin,
} from "../canonical-origin";
import { installedAccessBindings } from "./access-binding-fixture";
import type { Env } from "../types";

const env = installedAccessBindings({
  hostname: "tiller.preview.workers.dev",
}) as Env;

describe("canonical workers.dev origin", () => {
  it("accepts only the exact canonical production origin", async () => {
    await expect(canonicalIngressResponse(
      new Request("https://tiller.preview.workers.dev/api/execution/status"),
      env,
    )).resolves.toBeNull();
    const alias = await canonicalIngressResponse(
      new Request("https://alias.example.com/api/execution/status"),
      env,
    );
    expect(alias?.status).toBe(404);
  });

  it("fails closed without installer trust except for the DO-free health check", async () => {
    const unconfigured = {} as Env;
    await expect(canonicalIngressResponse(
      new Request("https://tiller.preview.workers.dev/health"),
      unconfigured,
    )).resolves.toBeNull();
    for (const path of ["/api/setup/status", "/", "/assets/index.js"]) {
      await expect(canonicalIngressResponse(
        new Request(`https://tiller.preview.workers.dev${path}`),
        unconfigured,
      )).resolves.toMatchObject({ status: 503 });
    }
    const blocked = await canonicalIngressResponse(
      new Request("https://tiller.preview.workers.dev/api/envs"),
      unconfigured,
    );
    expect(blocked?.status).toBe(503);
    expect(blocked?.headers.get("Cache-Control")).toBe("no-store");
    await expect(canonicalIngressResponse(
      new Request("https://tiller.preview.workers.dev/agents/reviewer-chat/default"),
      unconfigured,
    )).resolves.toMatchObject({ status: 503 });
    await expect(canonicalIngressResponse(
      new Request("https://tiller.preview.workers.dev/parties/hub/hub"),
      unconfigured,
    )).resolves.toMatchObject({ status: 503 });
  });

  it("preserves contributor localhost and rejects malformed trust hostnames", async () => {
    await expect(canonicalIngressResponse(
      new Request("http://localhost:5173/api/envs"),
      { LOCAL_DEV_ONLY_BACKEND: "1" } as Env,
    )).resolves.toBeNull();
    await expect(canonicalIngressResponse(
      new Request("https://alias.example.com/api/envs"),
      { ...env, LOCAL_DEV_ONLY_BACKEND: "1" } as Env,
    )).resolves.toMatchObject({ status: 404 });
    await expect(canonicalIngressResponse(
      new Request("http://localhost:5173/api/envs"),
      env,
    )).resolves.toMatchObject({ status: 404 });
    expect(() => workersDevOrigin("workers.dev")).toThrow();
    expect(() => workersDevOrigin("example.com")).toThrow();
  });

  it("parses one normalized route for origin, service, and account boundaries", () => {
    expect(parseCanonicalWorkersDevHostname(
      "Demo.Preview-Account.workers.dev.",
    )).toEqual({
      hostname: "demo.preview-account.workers.dev",
      origin: "https://demo.preview-account.workers.dev",
      serviceName: "demo",
      workersDevSubdomain: "preview-account",
    });
    expect(() => parseCanonicalWorkersDevHostname("demo.workers.dev")).toThrow();
    expect(() => parseCanonicalWorkersDevHostname("demo..preview.workers.dev")).toThrow();
  });
});
