export async function hmacHex(secret: string, value: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function adoptionPayload(args: {
  envSlug: string;
  operationId: string;
  workspaceHash: string;
  expectedPriorHead: string | null;
  baseCommitSha: string;
}): string {
  return [
    args.envSlug,
    args.operationId,
    args.workspaceHash,
    args.expectedPriorHead ?? "(none)",
    args.baseCommitSha,
  ].join("\n");
}
