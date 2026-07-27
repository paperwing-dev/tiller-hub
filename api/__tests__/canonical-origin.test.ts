import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCanonicalWorkersDevAccessTrust: vi.fn(),
}));

vi.mock("../workers-dev-access/records", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workers-dev-access/records")>()),
  readCanonicalWorkersDevAccessTrust: mocks.readCanonicalWorkersDevAccessTrust,
}));

import {
  canonicalIngressResponse,
  parseCanonicalWorkersDevHostname,
  workersDevOrigin,
} from "../canonical-origin";
import type { Env } from "../types";

const env = {} as Env;

describe("canonical workers.dev origin", () => {
  beforeEach(() => {
    mocks.readCanonicalWorkersDevAccessTrust.mockReset();
    mocks.readCanonicalWorkersDevAccessTrust.mockResolvedValue({
      workersDevHostname: "demo.preview.workers.dev",
    });
  });

  it("accepts only the exact canonical production origin", async () => {
    await expect(canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/api/execution/status"),
      env,
    )).resolves.toBeNull();
    const alias = await canonicalIngressResponse(
      new Request("https://alias.example.com/api/execution/status"),
      env,
    );
    expect(alias?.status).toBe(404);
  });

  it("fails closed without trust except for Access onboarding", async () => {
    mocks.readCanonicalWorkersDevAccessTrust.mockResolvedValue(null);
    await expect(canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/api/setup/status"),
      env,
    )).resolves.toBeNull();
    await expect(canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/"),
      env,
    )).resolves.toBeNull();
    await expect(canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/assets/index.js"),
      env,
    )).resolves.toBeNull();
    const blocked = await canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/api/envs"),
      env,
    );
    expect(blocked?.status).toBe(503);
    expect(blocked?.headers.get("Cache-Control")).toBe("no-store");
    await expect(canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default"),
      env,
    )).resolves.toMatchObject({ status: 503 });
    await expect(canonicalIngressResponse(
      new Request("https://demo.preview.workers.dev/parties/hub/hub"),
      env,
    )).resolves.toMatchObject({ status: 503 });
  });

  it("preserves contributor localhost and rejects malformed trust hostnames", async () => {
    await expect(canonicalIngressResponse(
      new Request("http://localhost:5173/api/envs"),
      { LOCAL_DEV_ONLY_BACKEND: "1" } as Env,
    )).resolves.toBeNull();
    await expect(canonicalIngressResponse(
      new Request("https://alias.example.com/api/envs"),
      { LOCAL_DEV_ONLY_BACKEND: "1" } as Env,
    )).resolves.toMatchObject({ status: 404 });
    await expect(canonicalIngressResponse(
      new Request("http://localhost:5173/api/envs"),
      {} as Env,
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
