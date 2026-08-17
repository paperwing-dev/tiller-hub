import type { EnvMeta } from "./types";

export interface RuntimeSessionCreateRequest {
  id: string | null;
  tag: string;
  cwd: string;
  host: string;
  platform: string;
  team: string | null;
}

export type RuntimeSessionCreateParseResult =
  | { ok: true; request: RuntimeSessionCreateRequest }
  | { ok: false; error: string };

const RUNTIME_SESSION_CREATE_FIELDS = new Set(["id", "tag", "cwd", "host", "platform", "team"]);

export function parseRuntimeSessionCreateRequest(
  body: Record<string, unknown>,
): RuntimeSessionCreateParseResult {
  const rejected = Object.keys(body).filter((key) => !RUNTIME_SESSION_CREATE_FIELDS.has(key));
  if (rejected.length > 0) {
    return {
      ok: false,
      error: `Runtime session request contains authority fields: ${rejected.join(", ")}`,
    };
  }
  const requiredString = (key: "tag" | "cwd" | "host" | "platform"): string | null => {
    const value = body[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const tag = requiredString("tag");
  const cwd = requiredString("cwd");
  const host = requiredString("host");
  const platform = requiredString("platform");
  if (!tag || !cwd || !host || !platform) {
    return { ok: false, error: "Runtime session descriptive fields are required" };
  }
  const id = body.id === undefined
    ? null
    : typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : null;
  const team = body.team === undefined
    ? null
    : typeof body.team === "string" && body.team.trim()
      ? body.team.trim()
      : null;
  if ((body.id !== undefined && id === null) || (body.team !== undefined && team === null)) {
    return { ok: false, error: "Runtime session descriptive fields are invalid" };
  }
  return { ok: true, request: { id, tag, cwd, host, platform, team } };
}

export function deriveRuntimeSessionAuthority(
  envSlug: string,
  meta: Pick<EnvMeta, "executionPlacement" | "harness" | "runnerId" | "repoUrl">,
  request: RuntimeSessionCreateRequest,
): {
  machineId: string | null;
  metadata: Record<string, unknown>;
} {
  const role = "lead" as const;
  return {
    machineId: meta.executionPlacement.backend === "host"
      ? meta.executionPlacement.machineId
      : null,
    metadata: {
      cwd: request.cwd,
      host: request.host,
      platform: request.platform,
      harness: meta.harness,
      envSlug,
      backend: meta.executionPlacement.backend,
      runnerId: meta.runnerId ?? envSlug,
      repoUrl: meta.repoUrl,
      ...(request.team ? { team: request.team } : {}),
      role,
      terminalScope: { kind: "environment", envSlug, role },
    },
  };
}
