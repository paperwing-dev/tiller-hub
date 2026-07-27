import { getArtifactStoreStub } from "../helpers";
import {
  listEnvDefinitionSlugs,
  persistEnvDefinition,
  readEnvDefinition,
} from "../plan/store";
import { loadTrackedRepo } from "../repo/access";
import type { Env, EnvDefinition } from "../types";

async function readEnvironmentDefinitions(env: Env): Promise<EnvDefinition[]> {
  const slugs = await listEnvDefinitionSlugs(env);
  const definitions = await Promise.all(slugs.map(async (slug) => {
    try {
      return await readEnvDefinition(env, slug);
    } catch (error) {
      console.warn(
        `[envs] Skipping invalid environment definition ${slug} during sidebar slot reconciliation:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }));
  return definitions.filter((definition): definition is EnvDefinition => definition !== null);
}

async function reconcileRepoEnvironmentSidebarSlots(
  env: Env,
  repoId: string,
  definitions: EnvDefinition[],
): Promise<void> {
  const repoDefinitions = definitions.filter((definition) => definition.repoId === repoId);
  const loadedRepo = await loadTrackedRepo(env, repoId);
  if (!loadedRepo.ok) {
    throw new Error(`Cannot reconcile sidebar slots for ${repoId}: ${loadedRepo.body.error}`);
  }
  const assignments = await getArtifactStoreStub(
    env,
    repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  ).reconcileEnvironmentSidebarSlots(
    repoDefinitions.map((definition) => ({
      slug: definition.slug,
      createdAt: definition.createdAt,
      ...(definition.sidebarSlot ? { sidebarSlot: definition.sidebarSlot } : {}),
    })),
  );
  const slots = new Map(assignments.map((assignment) => [assignment.slug, assignment.slot]));
  await Promise.all(repoDefinitions.map(async (definition) => {
    const sidebarSlot = slots.get(definition.slug);
    if (!sidebarSlot || definition.sidebarSlot === sidebarSlot) return;
    await persistEnvDefinition(env, { ...definition, sidebarSlot });
  }));
}

export async function ensureRepoEnvironmentSidebarSlots(env: Env, repoId: string): Promise<void> {
  const definitions = await readEnvironmentDefinitions(env);
  await reconcileRepoEnvironmentSidebarSlots(env, repoId, definitions);
}

export async function ensureEnvironmentSidebarSlots(env: Env): Promise<void> {
  const definitions = await readEnvironmentDefinitions(env);
  const repoIds = [...new Set(definitions.map((definition) => definition.repoId))];
  await Promise.all(repoIds.map((repoId) =>
    reconcileRepoEnvironmentSidebarSlots(env, repoId, definitions)
  ));
}
