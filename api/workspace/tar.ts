export interface TarEntry {
  path: string;
  content: Uint8Array;
  mtime?: number;
}

function normalizeTarEntryPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function readTarEntries(tarBuffer: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let buffer = tarBuffer;

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
    if (!fullName) continue;

    entries.set(normalizeTarEntryPath(fullName), content);
  }

  return entries;
}

export async function buildTar(entries: Iterable<TarEntry>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const entry of Array.from(entries).sort((left, right) => left.path.localeCompare(right.path))) {
    const header = new Uint8Array(512);
    const name = entry.path.startsWith("/") ? entry.path.slice(1) : entry.path;
    const nameBytes = encoder.encode(name);
    header.set(nameBytes.slice(0, 100), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    const sizeStr = entry.content.length.toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(sizeStr), 124);
    const mtime = Math.floor((entry.mtime ?? Date.now()) / 1000);
    header.set(encoder.encode(mtime.toString(8).padStart(11, "0") + "\0"), 136);
    header[156] = 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);

    header.set(encoder.encode("        "), 148);
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i];
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);

    chunks.push(header);
    chunks.push(entry.content);
    const remainder = entry.content.length % 512;
    if (remainder > 0) {
      chunks.push(new Uint8Array(512 - remainder));
    }
  }

  chunks.push(new Uint8Array(1024));
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
