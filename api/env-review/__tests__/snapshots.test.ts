import { describe, expect, it } from "vitest";
import {
  buildReviewSnapshotKey,
  buildReviewSnapshotTar,
  buildReviewSnapshotTarFromWorkspace,
  computeReviewSnapshotHash,
  createReviewSnapshotId,
  normalizeReviewSnapshotDeletedPaths,
  storeAndCompleteReviewSnapshot,
  TarBackedEnvReviewWorkspaceSource,
  validateReviewSnapshotTar,
} from "../snapshots";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarEntry(path: string, content = new Uint8Array(), typeFlag = "0"): Uint8Array[] {
  const header = new Uint8Array(512);
  header.set(bytes(path), 0);
  header.set(bytes("0000644\0"), 100);
  header.set(bytes("0000000\0"), 108);
  header.set(bytes("0000000\0"), 116);
  header.set(bytes(octal(content.byteLength, 12)), 124);
  header.set(bytes(octal(0, 12)), 136);
  header.set(bytes("        "), 148);
  header[156] = typeFlag.charCodeAt(0);
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

describe("review snapshots", () => {
  it("validates file entries and hashes normalized snapshot inputs", async () => {
    const validated = await validateReviewSnapshotTar(tar([
      tarEntry("src/b.txt", bytes("b")),
      tarEntry("src/a.txt", bytes("a")),
    ]));

    expect(validated.manifest.map((entry) => entry.path)).toEqual(["/src/a.txt", "/src/b.txt"]);
    const hash = await computeReviewSnapshotHash({
      manifest: validated.manifest,
      githubDeletedPaths: ["/src/z.txt", "/src/c.txt"],
      baseCommitSha: "base-sha",
    });
    const sameHash = await computeReviewSnapshotHash({
      manifest: validated.manifest.toReversed(),
      githubDeletedPaths: ["/src/c.txt", "/src/z.txt"],
      baseCommitSha: "base-sha",
    });
    expect(hash).toBe(sameHash);
  });

  it("uses deterministic snapshot IDs and does not delete same-hash retry artifacts", async () => {
    const tarBytes = buildReviewSnapshotTar([{ path: "/src/a.txt", content: bytes("a") }]);
    const validated = await validateReviewSnapshotTar(tarBytes);
    const snapshotHash = await computeReviewSnapshotHash({
      manifest: validated.manifest,
      githubDeletedPaths: [],
      baseCommitSha: "base-sha",
    });
    const snapshotId = createReviewSnapshotId("op-1", snapshotHash);
    const r2Key = buildReviewSnapshotKey("env-1", snapshotId);
    const existingSnapshot = {
      snapshotId,
      source: "live-harness" as const,
      mode: "github-overlay" as const,
      stale: false,
      createdAt: "2026-06-21T00:00:00.000Z",
      snapshotHash,
      baseCommitSha: "base-sha",
      githubDeletedPaths: [],
      r2Key,
    };
    const bucket = {
      put: async () => ({}),
      delete: async () => {
        throw new Error("same-hash retry must not delete deterministic snapshot artifact");
      },
    };
    const review = {
      completeSnapshotPreparation: async (input: any) => ({
        status: "already_completed" as const,
        sameSnapshotHash: true,
        operation: {
          ...input,
          status: "succeeded" as const,
          result: {
            ...input.result,
            snapshot: existingSnapshot,
          },
        },
      }),
      completeSavedSnapshotPreparation: async () => {
        throw new Error("unexpected saved snapshot completion");
      },
    };

    await expect(storeAndCompleteReviewSnapshot({
      bucket: bucket as any,
      review,
      op: {
        opId: "op-1",
        envSlug: "env-1",
        sessionId: "session-1",
        status: "preparing",
        result: null,
        requestUrl: "https://hub.example",
        ackToken: "token-1",
        snapshotRequestedAt: "2026-06-21T00:00:00.000Z",
        snapshotAttempts: 1,
        snapshotRequest: {
          snapshotMode: "github-overlay",
          baseCommitSha: "base-sha",
          maxBytes: 50 * 1024 * 1024,
          excludePrefixes: [],
        },
        timeoutAt: null,
        startedAt: "2026-06-21T00:00:00.000Z",
        completedAt: null,
        error: null,
      },
      source: "live-harness",
      mode: "github-overlay",
      stale: false,
      tarBytes,
      validated,
      githubDeletedPaths: [],
      baseCommitSha: "base-sha",
      uploadToken: "token-1",
      snapshotHash,
      createdAt: "2026-06-21T00:00:00.000Z",
    })).resolves.toMatchObject({
      status: "already_completed",
      snapshot: existingSnapshot,
    });
    expect(createReviewSnapshotId("op-1", snapshotHash)).toBe(snapshotId);
  });

  it("rejects unsafe, excluded, duplicate, and unsupported tar entries", async () => {
    await expect(validateReviewSnapshotTar(tar([tarEntry("../secret.txt", bytes("x"))])))
      .rejects.toThrow(/unsafe path/);
    await expect(validateReviewSnapshotTar(tar([tarEntry(".tiller/state.json", bytes("x"))])))
      .rejects.toThrow(/excluded path/);
    await expect(validateReviewSnapshotTar(tar([
      tarEntry("src/a.txt", bytes("1")),
      tarEntry("src/a.txt", bytes("2")),
    ]))).rejects.toThrow(/duplicate entry/);
    await expect(validateReviewSnapshotTar(tar([tarEntry("src/link", new Uint8Array(), "2")])))
      .rejects.toThrow(/unsupported entry type/);
  });

  it("normalizes GitHub deleted paths without truncating invalid metadata", () => {
    expect(normalizeReviewSnapshotDeletedPaths(["/b.txt", "/a.txt", "/b.txt"])).toEqual(["/a.txt", "/b.txt"]);
    expect(() => normalizeReviewSnapshotDeletedPaths(["relative.txt"])).toThrow(/Invalid GitHub deleted path/);
    expect(() => normalizeReviewSnapshotDeletedPaths(["/.tiller/state.json"])).toThrow(/excluded/);
  });

  it("writes ustar-prefixed review snapshot paths instead of truncating long paths", async () => {
    const longPath = `/src/${"nested/".repeat(16)}file.txt`;
    expect(new TextEncoder().encode(longPath.slice(1)).byteLength).toBeGreaterThan(100);

    const validated = await validateReviewSnapshotTar(buildReviewSnapshotTar([
      { path: longPath, content: bytes("long path content") },
    ]));

    expect(validated.manifest).toEqual([
      expect.objectContaining({ path: longPath, size: "long path content".length }),
    ]);
    await expect(new TarBackedEnvReviewWorkspaceSource(
      buildReviewSnapshotTar([{ path: longPath, content: bytes("long path content") }]),
    ).readWorkspaceFileBytes(longPath)).resolves.toEqual(bytes("long path content"));
  });

  it("rejects review snapshot paths that ustar cannot represent", () => {
    expect(() => buildReviewSnapshotTar([
      { path: `/src/${"a".repeat(101)}`, content: bytes("too long") },
    ])).toThrow(/too long for ustar/);
  });

  it("builds saved-workspace review snapshots with review tar policy", async () => {
    const workspace = {
      globWorkspace: async () => [
        { path: "/src/a.txt", type: "file" },
        { path: "/.tiller/state.json", type: "file" },
        { path: "/src", type: "directory" },
      ],
      readWorkspaceFileBytes: async (path: string) => path === "/src/a.txt" ? bytes("a") : null,
    };

    const validated = await validateReviewSnapshotTar(await buildReviewSnapshotTarFromWorkspace(workspace));

    expect(validated.manifest.map((entry) => entry.path)).toEqual(["/src/a.txt"]);
  });

  it("serves repeated tar-backed context reads from the parsed snapshot", async () => {
    const source = new TarBackedEnvReviewWorkspaceSource(
      tar([tarEntry("src/a.txt", bytes("hello"))]),
      ["/old.txt"],
    );

    await expect(source.readWorkspaceFileBytes("/src/a.txt"))
      .resolves.toEqual(bytes("hello"));
    await expect(source.readWorkspaceFileBytes("/src/a.txt"))
      .resolves.toEqual(bytes("hello"));
    await expect(source.readGitHubDeletedWorkspacePaths()).resolves.toEqual(["/old.txt"]);
  });
});
