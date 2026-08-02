import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCanonicalReleaseBundle } from "../../../scripts/prepare-installer-release.mjs";

const directories: string[] = [];

async function bundlePath(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "tiller-canonical-bundle-test-"),
  );
  directories.push(directory);
  return path.join(directory, "tiller-hub-v1.2.3.tar.gz");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("installer preparation canonical bundle download", () => {
  it("uses the published bundle as descriptor input instead of rebuilding an archive", async () => {
    const source = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../../scripts/prepare-installer-release.mjs",
      ),
      "utf8",
    );
    expect(source).toContain(
      "downloadCanonicalReleaseBundle({ version, bundlePath })",
    );
    expect(
      source.indexOf("downloadCanonicalReleaseBundle({ version, bundlePath })"),
    ).toBeLessThan(source.indexOf("buildReleaseDescriptor({"));
    expect(source).not.toContain("createPortableReleaseArchive");
    expect(source).not.toContain('["--format=ustar"');
  });

  it("downloads the exact canonical release bytes with bounded request headers", async () => {
    const destination = await bundlePath();
    const bytes = Buffer.from("canonical-release-bytes");
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          headers: { "Content-Length": String(bytes.byteLength) },
        }),
    );

    const result = await downloadCanonicalReleaseBundle({
      version: "1.2.3",
      bundlePath: destination,
      fetchImpl,
      maxBytes: 64,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.com/paperwing-dev/tiller-hub/releases/download/tiller-hub-v1.2.3/tiller-hub-v1.2.3.tar.gz",
      {
        redirect: "follow",
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "tiller-installer-release-preparer",
        },
      },
    );
    expect(result).toMatchObject({ size: bytes.byteLength, reused: false });
    expect((await readFile(destination)).equals(bytes)).toBe(true);
  });

  it("rejects advertised and streamed bundles beyond the bound without writing a file", async () => {
    const advertisedDestination = await bundlePath();
    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: advertisedDestination,
        fetchImpl: async () =>
          new Response("small", {
            headers: { "Content-Length": "65" },
          }),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/exceeds its size limit/);
    await expect(readFile(advertisedDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const streamedDestination = await bundlePath();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: streamedDestination,
        fetchImpl: async () => new Response(body),
        maxBytes: 5,
      }),
    ).rejects.toThrow(/exceeds its size limit/);
    await expect(readFile(streamedDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses identical local bytes and refuses to clobber a different bundle", async () => {
    const destination = await bundlePath();
    await writeFile(destination, "canonical");

    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: destination,
        fetchImpl: async () => new Response("canonical"),
        maxBytes: 64,
      }),
    ).resolves.toMatchObject({ reused: true, size: 9 });

    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: destination,
        fetchImpl: async () => new Response("different"),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/Refusing to replace/);
    await expect(readFile(destination, "utf8")).resolves.toBe("canonical");
  });

  it("rejects empty, truncated, and failed responses before touching the destination", async () => {
    const destination = await bundlePath();
    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: destination,
        fetchImpl: async () => new Response("missing", { status: 404 }),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: destination,
        fetchImpl: async () =>
          new Response("short", {
            headers: { "Content-Length": "6" },
          }),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/does not match Content-Length/);
    await expect(
      downloadCanonicalReleaseBundle({
        version: "1.2.3",
        bundlePath: destination,
        fetchImpl: async () => new Response(null),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/HTTP 200|empty/);
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
