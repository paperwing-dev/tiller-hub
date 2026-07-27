import type { StoredSession } from "../api/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMetadata(session: Pick<StoredSession, "metadata">): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(session.metadata) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getManagedEnvSlug(session: Pick<StoredSession, "metadata">): string | null {
  const metadata = parseMetadata(session);
  const envSlug = typeof metadata?.envSlug === "string" ? metadata.envSlug.trim() : "";
  return envSlug || null;
}

export function getManagedSessionRole(session: Pick<StoredSession, "metadata">): string | null {
  const metadata = parseMetadata(session);
  const role = typeof metadata?.role === "string" ? metadata.role.trim() : "";
  return role || null;
}

export function isManagedSessionForEnv(
  session: Pick<StoredSession, "metadata">,
  envSlug: string,
): boolean {
  return getManagedEnvSlug(session) === envSlug;
}

export function pickPrimaryEnvSession(
  sessions: StoredSession[],
  envSlug: string,
): StoredSession | null {
  return sessions.find(
    (session) =>
      isManagedSessionForEnv(session, envSlug) &&
      getManagedSessionRole(session) === "lead",
  ) ?? null;
}
