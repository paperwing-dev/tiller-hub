import { DurableObject } from "cloudflare:workers";
import { Workspace, type FileInfo } from "agents/experimental/workspace";
import type { Env } from "../types";
import { createWorkspaceHost } from "./host";

export interface ManifestEntry {
  path: string;
  size: number;
  mtime: number;
}

function matchesAnyPrefix(path: string, prefixes: string[] = []): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class WorkspaceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private _workspace: Workspace | null = null;

  private get workspace(): Workspace {
    if (!this._workspace) {
      this._workspace = new Workspace(createWorkspaceHost(this.ctx), {
        r2: this.env.BUCKET,
        r2Prefix: this.ctx.id.toString(),
        inlineThreshold: 1_000_000,
      });
    }
    return this._workspace;
  }

  getManifest(): ManifestEntry[] {
    console.log("[workspace-do] getManifest called");
    const files = this.workspace.glob("**/*").filter((f) => f.type === "file");
    console.log(`[workspace-do] getManifest -> ${files.length} files`);
    return files.map((f) => ({ path: f.path, size: f.size, mtime: f.updatedAt }));
  }

  async readWorkspaceFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  async writeWorkspaceFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(path, content);
  }

  async readWorkspaceFileBytes(path: string): Promise<Uint8Array | null> {
    return this.workspace.readFileBytes(path);
  }

  async writeWorkspaceFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.workspace.writeFileBytes(path, content);
  }

  async writeWorkspaceFiles(files: { path: string; content: string }[]): Promise<void> {
    for (const file of files) {
      await this.workspace.writeFile(file.path, file.content);
    }
  }

  async deleteWorkspaceFile(path: string): Promise<boolean> {
    return this.workspace.deleteFile(path);
  }

  async deleteWorkspaceFiles(paths: string[]): Promise<void> {
    for (const path of paths) {
      await this.workspace.deleteFile(path);
    }
  }

  readWorkspaceDir(dir?: string): FileInfo[] {
    return this.workspace.readDir(dir);
  }

  globWorkspace(pattern: string): FileInfo[] {
    return this.workspace.glob(pattern);
  }

  getWorkspaceInfo(): { fileCount: number; directoryCount: number; totalBytes: number; r2FileCount: number } {
    return this.workspace.getWorkspaceInfo();
  }

  async batchReadWorkspaceFiles(paths: string[]): Promise<{ path: string; content: string | null }[]> {
    const results: { path: string; content: string | null }[] = [];
    for (const path of paths) {
      results.push({
        path,
        content: await this.workspace.readFile(path),
      });
    }
    return results;
  }

  async clearWorkspacePlanFile(): Promise<void> {
    await this.workspace.deleteFile("/.tiller/plan.md");
  }

  async computeWorkspaceTreeHash(options?: { excludePrefixes?: string[] }): Promise<string> {
    const encoder = new TextEncoder();
    const files = this.workspace
      .glob("**/*")
      .filter((entry) => entry.type === "file" && !matchesAnyPrefix(entry.path, options?.excludePrefixes))
      .sort((left, right) => left.path.localeCompare(right.path));

    const entries: string[] = [];
    for (const file of files) {
      const body = await this.workspace.readFileBytes(file.path);
      if (body === null) continue;
      entries.push(`${file.path}\0${await sha256HexBytes(body)}`);
    }

    return sha256HexBytes(encoder.encode(entries.join("\n")));
  }

  async downloadTar(options?: { excludePrefixes?: string[] }): Promise<Uint8Array> {
    console.log("[workspace-do] downloadTar called");
    const files = this.workspace
      .glob("**/*")
      .filter((f) => f.type === "file" && !matchesAnyPrefix(f.path, options?.excludePrefixes));
    console.log(`[workspace-do] downloadTar: ${files.length} files to pack`);
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const file of files) {
      const body = await this.workspace.readFileBytes(file.path);
      if (body === null) {
        console.warn(`[tar] skipping file not found in workspace: ${file.path}`);
        continue;
      }

      const header = new Uint8Array(512);
      const name = file.path.startsWith("/") ? file.path.slice(1) : file.path;
      const nameBytes = encoder.encode(name);
      header.set(nameBytes.slice(0, 100), 0);
      header.set(encoder.encode("0000644\0"), 100);
      header.set(encoder.encode("0000000\0"), 108);
      header.set(encoder.encode("0000000\0"), 116);
      const sizeStr = body.length.toString(8).padStart(11, "0") + "\0";
      header.set(encoder.encode(sizeStr), 124);
      const mtime = Math.floor((file.updatedAt || Date.now()) / 1000);
      header.set(encoder.encode(mtime.toString(8).padStart(11, "0") + "\0"), 136);
      header[156] = 48;
      header.set(encoder.encode("ustar\0"), 257);
      header.set(encoder.encode("00"), 263);

      header.set(encoder.encode("        "), 148);
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += header[i];
      header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);

      chunks.push(header);
      chunks.push(body);
      const remainder = body.length % 512;
      if (remainder > 0) chunks.push(new Uint8Array(512 - remainder));
    }

    chunks.push(new Uint8Array(1024));

    const result = new Uint8Array(await new Blob(chunks).arrayBuffer());
    console.log(`[workspace-do] downloadTar -> ${result.byteLength} bytes`);
    return result;
  }

  private async restoreFromTarBuffer(
    tarBuffer: Uint8Array,
    options?: { preservePrefixes?: string[]; clearFirst?: boolean; stripFirstSegment?: boolean },
  ): Promise<{ fileCount: number }> {
    if (options?.clearFirst) {
      const files = this.workspace.glob("**/*").filter((entry) =>
        entry.type === "file" && !matchesAnyPrefix(entry.path, options.preservePrefixes),
      );
      for (const file of files) {
        await this.workspace.deleteFile(file.path);
      }
    }

    let fileCount = 0;
    let buffer = tarBuffer;
    const decoder = new TextDecoder();

    while (buffer.length >= 512) {
      const header = buffer.slice(0, 512);
      if (header.every((byte) => byte === 0)) break;

      const rawName = decoder.decode(header.slice(0, 100)).replace(/\0.*$/, "");
      const sizeOctal = decoder.decode(header.slice(124, 136)).replace(/\0.*$/, "").trim();
      const typeFlag = decoder.decode(header.slice(156, 157));
      const prefix = decoder.decode(header.slice(345, 500)).replace(/\0.*$/, "");

      const fullName = prefix ? `${prefix}/${rawName}` : rawName;
      const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
      const paddedSize = Math.ceil(size / 512) * 512;
      buffer = buffer.slice(512);

      if (buffer.length < paddedSize) {
        throw new Error("Invalid tar archive: truncated entry payload");
      }

      const content = buffer.slice(0, size);
      buffer = buffer.slice(paddedSize);

      if (typeFlag === "5" || typeFlag === "g" || typeFlag === "x") continue;
      if (size === 0 && rawName.endsWith("/")) continue;

      const normalizedFullName = fullName.startsWith("/") ? fullName.slice(1) : fullName;
      const pathSegments = normalizedFullName.split("/").filter(Boolean);
      const relativePath = options?.stripFirstSegment ? pathSegments.slice(1).join("/") : normalizedFullName;
      if (!relativePath) continue;
      const workspacePath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
      if (
        workspacePath.includes("/node_modules/") ||
        workspacePath.includes("/__pycache__/") ||
        workspacePath.includes("/.git/objects/") ||
        workspacePath.includes("/.terraform/") ||
        workspacePath.includes("/vendor/") ||
        workspacePath.includes("/dist/") ||
        workspacePath.includes("/.next/") ||
        workspacePath.includes("/build/")
      ) continue;

      await this.workspace.writeFileBytes(workspacePath, content);
      fileCount++;
    }

    return { fileCount };
  }

  async restoreFromTar(
    tarBuffer: Uint8Array,
    options?: { preservePrefixes?: string[]; clearFirst?: boolean },
  ): Promise<{ fileCount: number }> {
    return this.restoreFromTarBuffer(tarBuffer, options);
  }

  async initFromTarball(tarballUrl: string, headers?: Record<string, string>): Promise<{ fileCount: number }> {
    const resp = await fetch(tarballUrl, {
      headers: headers ?? {},
      redirect: "follow",
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`Failed to fetch tarball: ${resp.status} ${resp.statusText}`);
    }

    const decompressed = resp.body.pipeThrough(new DecompressionStream("gzip"));
    const tarBuffer = new Uint8Array(await new Response(decompressed).arrayBuffer());
    return this.restoreFromTarBuffer(tarBuffer, { stripFirstSegment: true });
  }

  async destroyWorkspaceR2(): Promise<void> {
    const prefix = this.ctx.id.toString() + "/";
    let cursor: string | undefined;
    do {
      const listed = await this.env.BUCKET.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await Promise.all(listed.objects.map((obj) => this.env.BUCKET.delete(obj.key)));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  async destroyWorkspace(): Promise<void> {
    const files = this.workspace.glob("**/*").filter((entry) => entry.type === "file");
    for (const file of files) {
      await this.workspace.deleteFile(file.path);
    }
    await this.destroyWorkspaceR2();
  }
}
