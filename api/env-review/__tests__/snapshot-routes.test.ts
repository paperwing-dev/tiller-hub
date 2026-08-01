import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";
import { computeReviewSnapshotHash, ENV_REVIEW_UPLOAD_TOKEN_HEADER } from "../snapshots";

const mocks = vi.hoisted(() => ({
  loadEnvView: vi.fn(),
  getEnvReviewStub: vi.fn(),
}));

vi.mock("../../env/view", () => ({
  loadEnvView: mocks.loadEnvView,
}));

vi.mock("../../helpers", () => ({
  getEnvReviewStub: mocks.getEnvReviewStub,
  getThreadStub: vi.fn(),
}));

vi.mock("../../repo/access", () => ({
  loadRepoForRequest: vi.fn(),
}));

vi.mock("../../planner/runtime", () => ({
  appendThreadMessage: vi.fn(),
}));

vi.mock("../../planner/providers", () => ({
  findPlannerProviderEffort: vi.fn(),
  findPlannerProviderModel: vi.fn(),
  getPlannerProviderModelDefaultEffort: vi.fn(),
  listPlannerProviders: vi.fn(),
}));

vi.mock("../dispatch", () => ({
  cleanupEnvReviewRunRuntime: vi.fn(),
  resolveNewEnvReviewLaunchProvenance: vi.fn(async () => ({
    backend: "cf",
    machineId: null,
  })),
}));

const { default: envReviewRoutes } = await import("../routes");

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarEntry(path: string, content = new Uint8Array()): Uint8Array[] {
  const header = new Uint8Array(512);
  header.set(bytes(path), 0);
  header.set(bytes("0000644\0"), 100);
  header.set(bytes("0000000\0"), 108);
  header.set(bytes("0000000\0"), 116);
  header.set(bytes(octal(content.byteLength, 12)), 124);
  header.set(bytes(octal(0, 12)), 136);
  header.set(bytes("        "), 148);
  header[156] = "0".charCodeAt(0);
  header.set(bytes("ustar\0"), 257);
  header.set(bytes("00"), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(bytes(checksum.toString(8).padStart(6, "0") + "\0 "), 148);

  const padding = content.byteLength % 512 === 0 ? 0 : 512 - (content.byteLength % 512);
  return padding > 0 ? [header, content, new Uint8Array(padding)] : [header, content];
}

function tar(entries: Uint8Array[][]): Uint8Array {
  const chunks = [...entries.flat(), new Uint8Array(1024)];
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function uploadForm(metadata: Record<string, unknown>, workspace = tar([tarEntry("src/a.txt", bytes("hello"))])): FormData {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("workspace", new Blob([workspace], { type: "application/x-tar" }), "workspace.tar");
  return form;
}

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", envReviewRoutes);
  return app;
}

function baseMeta(overrides: Record<string, unknown> = {}) {
  return {
    slug: "env-1",
    repoId: "repo-1",
    scmModel: "github",
    githubBaseCommitSha: "base-sha",
    ...overrides,
  };
}

describe("env review snapshot upload route", () => {
  it("rejects terminal failed operations before parsing upload body", async () => {
    mocks.loadEnvView.mockResolvedValue(baseMeta());
    const review = {
      getPreparationOperation: vi.fn(async () => ({
        opId: "op-1",
        envSlug: "env-1",
        sessionId: "session-1",
        status: "failed",
        ackToken: "token-1",
        result: null,
      })),
      failPreparationOperationIfPreparing: vi.fn(),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const res = await createApp().request("https://hub.example/api/envs/env-1/review/snapshots/op-1", {
      method: "PUT",
      headers: { [ENV_REVIEW_UPLOAD_TOKEN_HEADER]: "token-1" },
      body: "not multipart",
    }, { BUCKET: {} } as any);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Review preparation is already failed" });
    expect(review.failPreparationOperationIfPreparing).not.toHaveBeenCalled();
  });

  it("fails an active GitHub overlay upload that omits deletion metadata", async () => {
    mocks.loadEnvView.mockResolvedValue(baseMeta());
    const review = {
      getPreparationOperation: vi.fn(async () => ({
        opId: "op-1",
        envSlug: "env-1",
        sessionId: "session-1",
        status: "preparing",
        ackToken: "token-1",
        snapshotRequest: {
          snapshotMode: "github-overlay",
          baseCommitSha: "base-sha",
          maxBytes: 50 * 1024 * 1024,
          excludePrefixes: ["/.tiller"],
        },
        result: null,
      })),
      failPreparationOperationIfPreparing: vi.fn(async () => ({ status: "failed", operation: {} })),
      listRunsForPreparationOperation: vi.fn(async () => []),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const res = await createApp().request("https://hub.example/api/envs/env-1/review/snapshots/op-1", {
      method: "PUT",
      headers: { [ENV_REVIEW_UPLOAD_TOKEN_HEADER]: "token-1" },
      body: uploadForm({ snapshotMode: "github-overlay", baseCommitSha: "base-sha" }),
    }, { BUCKET: {} } as any);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "githubDeletedPaths is required for GitHub overlay snapshots",
    });
    expect(review.failPreparationOperationIfPreparing).toHaveBeenCalledOnce();
  });

  it("fails active uploads that are missing stored snapshot request metadata", async () => {
    mocks.loadEnvView.mockResolvedValue(baseMeta());
    const review = {
      getPreparationOperation: vi.fn(async () => ({
        opId: "op-1",
        envSlug: "env-1",
        sessionId: "session-1",
        status: "preparing",
        ackToken: "token-1",
        snapshotRequest: null,
        result: null,
      })),
      failPreparationOperationIfPreparing: vi.fn(async () => ({ status: "failed", operation: {} })),
      listRunsForPreparationOperation: vi.fn(async () => []),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const res = await createApp().request("https://hub.example/api/envs/env-1/review/snapshots/op-1", {
      method: "PUT",
      headers: { [ENV_REVIEW_UPLOAD_TOKEN_HEADER]: "token-1" },
      body: uploadForm({
        snapshotMode: "github-overlay",
        baseCommitSha: "base-sha",
        githubDeletedPaths: [],
      }),
    }, { BUCKET: {} } as any);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "Review snapshot request metadata is unavailable. Retry review.",
    });
    expect(review.failPreparationOperationIfPreparing).toHaveBeenCalledOnce();
  });

  it("stores and completes an active live snapshot upload through the shared finalizer", async () => {
    mocks.loadEnvView.mockResolvedValue(baseMeta());
    const bucket = {
      put: vi.fn(async () => ({})),
    };
    const review = {
      getPreparationOperation: vi.fn(async () => ({
        opId: "op-1",
        envSlug: "env-1",
        sessionId: "session-1",
        status: "preparing",
        ackToken: "token-1",
        snapshotRequest: {
          snapshotMode: "github-overlay",
          baseCommitSha: "base-sha",
          maxBytes: 50 * 1024 * 1024,
          excludePrefixes: ["/.tiller"],
        },
        result: null,
      })),
      completeSnapshotPreparation: vi.fn(async (input) => ({
        status: "completed",
        operation: { status: "succeeded", result: input.result },
      })),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const res = await createApp().request("https://hub.example/api/envs/env-1/review/snapshots/op-1", {
      method: "PUT",
      headers: { [ENV_REVIEW_UPLOAD_TOKEN_HEADER]: "token-1" },
      body: uploadForm({
        snapshotMode: "github-overlay",
        baseCommitSha: "base-sha",
        githubDeletedPaths: [],
      }),
    }, { BUCKET: bucket } as any);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      snapshot: {
        source: "live-harness",
        mode: "github-overlay",
        stale: false,
        baseCommitSha: "base-sha",
        githubDeletedPaths: [],
      },
    });
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^envs\/env-1\/review-snapshots\/.+\.tar$/),
      expect.any(Uint8Array),
      expect.objectContaining({ httpMetadata: { contentType: "application/x-tar" } }),
    );
    expect(review.completeSnapshotPreparation).toHaveBeenCalledWith(expect.objectContaining({
      envSlug: "env-1",
      sessionId: "session-1",
      opId: "op-1",
      uploadToken: "token-1",
      result: expect.objectContaining({
        snapshot: expect.objectContaining({ source: "live-harness" }),
      }),
    }));
    expect(review.scheduleOrchestration).toHaveBeenCalledOnce();
  });

  it("accepts a completed same-hash retry using stored snapshot metadata, not current env metadata", async () => {
    mocks.loadEnvView.mockResolvedValue(baseMeta({ githubBaseCommitSha: "new-base-sha" }));
    const workspace = tar([tarEntry("src/a.txt", bytes("hello"))]);
    const validatedHash = await computeReviewSnapshotHash({
      manifest: [{ path: "/src/a.txt", size: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }],
      githubDeletedPaths: ["/old.txt"],
      baseCommitSha: "base-sha",
    });
    const snapshot = {
      snapshotId: "snapshot-1",
      source: "live-harness",
      mode: "github-overlay",
      stale: false,
      createdAt: "2026-06-21T00:00:00.000Z",
      snapshotHash: validatedHash,
      baseCommitSha: "base-sha",
      githubDeletedPaths: ["/old.txt"],
      r2Key: "envs/env-1/review-snapshots/snapshot-1.tar",
    };
    const review = {
      getPreparationOperation: vi.fn(async () => ({
        opId: "op-1",
        envSlug: "env-1",
        sessionId: "session-1",
        status: "succeeded",
        ackToken: "token-1",
        result: { snapshot },
      })),
      failPreparationOperationIfPreparing: vi.fn(),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const res = await createApp().request("https://hub.example/api/envs/env-1/review/snapshots/op-1", {
      method: "PUT",
      headers: { [ENV_REVIEW_UPLOAD_TOKEN_HEADER]: "token-1" },
      body: uploadForm({
        snapshotMode: "github-overlay",
        baseCommitSha: "base-sha",
        githubDeletedPaths: ["/old.txt"],
      }, workspace),
    }, { BUCKET: {} } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, idempotent: true });
    expect(review.failPreparationOperationIfPreparing).not.toHaveBeenCalled();
  });
});
