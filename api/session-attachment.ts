import type { StoredSession, TerminalScope } from "./types";

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
  const scope = readTerminalScopeFromMetadata(metadata);
  if (scope?.kind === "environment") return scope.envSlug;
  return readTrimmedString(metadata.envSlug);
}

export function readManagedRoleFromMetadata(metadata: unknown): string | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const scope = readTerminalScopeFromMetadata(metadata);
  if (scope?.kind === "environment") return scope.role;
  return readTrimmedString(metadata.role);
}

export function readTerminalScopeFromMetadata(metadata: unknown): TerminalScope | null {
  if (!isRecord(metadata) || !isRecord(metadata.terminalScope)) return null;
  const scope = metadata.terminalScope;
  if (scope.kind === "environment") {
    const envSlug = readTrimmedString(scope.envSlug);
    const role = readTrimmedString(scope.role);
    return envSlug && role ? { kind: "environment", envSlug, role } : null;
  }
  if (scope.kind === "plan-writer") {
    const repoId = readTrimmedString(scope.repoId);
    const planArtifactId = readTrimmedString(scope.planArtifactId);
    const generation = scope.generation;
    const revokedAt = readTrimmedString(scope.revokedAt);
    if (!repoId || !planArtifactId || !Number.isInteger(generation) || (generation as number) < 1) return null;
    return {
      kind: "plan-writer",
      repoId,
      planArtifactId,
      generation: generation as number,
      ...(revokedAt ? { revokedAt } : {}),
    };
  }
  return null;
}

export function readTerminalScopeFromStoredSession(
  session: Pick<StoredSession, "metadata">,
): TerminalScope | null {
  try {
    const metadata = JSON.parse(session.metadata) as unknown;
    const explicit = readTerminalScopeFromMetadata(metadata);
    if (explicit) return explicit;
    const envSlug = readManagedEnvSlugFromMetadata(metadata);
    const role = readManagedRoleFromMetadata(metadata);
    return envSlug && role ? { kind: "environment", envSlug, role } : null;
  } catch {
    return null;
  }
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
    const scope = readTerminalScopeFromStoredSession(session);
    if (scope?.kind === "plan-writer") continue;
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
    const scope = readTerminalScopeFromStoredSession(session);
    if (scope?.kind === "plan-writer") continue;
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

export function filterRoutableActiveManagedSessions(
  sessions: StoredSession[],
  routableSessionIds: Iterable<string>,
): StoredSession[] {
  const routable = new Set(routableSessionIds);
  return sessions.filter((session) => (
    session.active === 1 &&
    session.ended_at === null &&
    routable.has(session.id)
  ));
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
  const currentScope = readTerminalScopeFromStoredSession(session);
  const nextScope = readTerminalScopeFromMetadata(nextMetadata);
  if (currentScope?.kind === "plan-writer") {
    return nextScope?.kind === "plan-writer"
      && currentScope.repoId === nextScope.repoId
      && currentScope.planArtifactId === nextScope.planArtifactId
      && currentScope.generation === nextScope.generation
      && (!currentScope.revokedAt || currentScope.revokedAt === nextScope.revokedAt);
  }
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
