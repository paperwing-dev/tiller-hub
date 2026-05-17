import type { StoredSession } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function readManagedEnvSlugFromMetadata(metadata: unknown): string | null {
  if (!isRecord(metadata)) {
    return null;
  }
  return readTrimmedString(metadata.envSlug);
}

export function readManagedRoleFromMetadata(metadata: unknown): string | null {
  if (!isRecord(metadata)) {
    return null;
  }
  return readTrimmedString(metadata.role);
}

export function readManagedRoleFromStoredSession(
  session: Pick<StoredSession, "metadata">,
): string | null {
  try {
    return readManagedRoleFromMetadata(JSON.parse(session.metadata) as unknown);
  } catch {
    return null;
  }
}

export function readManagedEnvSlugFromStoredSession(
  session: Pick<StoredSession, "metadata">,
): string | null {
  try {
    return readManagedEnvSlugFromMetadata(JSON.parse(session.metadata) as unknown);
  } catch {
    return null;
  }
}

export function partitionManagedSessions(
  sessions: StoredSession[],
  existingEnvSlugs: Set<string>,
): { managedSessions: StoredSession[]; orphanSessionIds: string[] } {
  const managedSessions: StoredSession[] = [];
  const orphanSessionIds: string[] = [];

  for (const session of sessions) {
    const envSlug = readManagedEnvSlugFromStoredSession(session);
    const role = readManagedRoleFromStoredSession(session);
    if (!envSlug || !role || !existingEnvSlugs.has(envSlug)) {
      orphanSessionIds.push(session.id);
      continue;
    }
    managedSessions.push(session);
  }

  return { managedSessions, orphanSessionIds };
}

export async function partitionManagedSessionsByLookup(
  sessions: StoredSession[],
  envExists: (envSlug: string) => boolean | Promise<boolean>,
): Promise<{ managedSessions: StoredSession[]; orphanSessionIds: string[] }> {
  const managedSessions: StoredSession[] = [];
  const orphanSessionIds: string[] = [];

  for (const session of sessions) {
    const envSlug = readManagedEnvSlugFromStoredSession(session);
    const role = readManagedRoleFromStoredSession(session);
    if (!envSlug || !role || !(await envExists(envSlug))) {
      orphanSessionIds.push(session.id);
      continue;
    }
    managedSessions.push(session);
  }

  return { managedSessions, orphanSessionIds };
}

export function listManagedSessionIdsForEnv(
  sessions: StoredSession[],
  envSlug: string,
): string[] {
  return sessions
    .filter((session) => readManagedEnvSlugFromStoredSession(session) === envSlug)
    .map((session) => session.id);
}

export function isManagedSessionMetadataUpdateValid(
  session: Pick<StoredSession, "metadata">,
  nextMetadata: unknown,
): boolean {
  const currentEnvSlug = readManagedEnvSlugFromStoredSession(session);
  const currentRole = readManagedRoleFromStoredSession(session);
  const nextEnvSlug = readManagedEnvSlugFromMetadata(nextMetadata);
  const nextRole = readManagedRoleFromMetadata(nextMetadata);

  return !!(
    currentEnvSlug
    && currentRole
    && nextEnvSlug
    && nextRole
    && currentEnvSlug === nextEnvSlug
    && currentRole === nextRole
  );
}
