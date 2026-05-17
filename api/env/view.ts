import { getEnvLifecycleStub } from "../helpers";
import type { Env, EnvDefinition, EnvMeta } from "../types";
import {
  listEnvDefinitionSlugs,
  readEnvDefinition,
} from "../plan/store";
import { loadRepoProjection } from "../repo/access";
import {
  buildEnvMetaFromLayers,
  createFallbackMutableState,
} from "./state";

async function readRepoUrlForEnvDefinition(
  env: Env,
  definition: EnvDefinition,
): Promise<string> {
  const repo = await loadRepoProjection(env, definition.repoId);
  if (repo.ok) {
    return repo.repo.repoUrl;
  }
  throw new Error(`Environment ${definition.slug} references missing repo ${definition.repoId}.`);
}

export async function loadEnvView(env: Env, slug: string): Promise<EnvMeta | null> {
  const definition = await readEnvDefinition(env, slug);
  if (!definition) {
    return null;
  }

  const mutableState =
    (await getEnvLifecycleStub(env, slug).peekMutableState())
    ?? createFallbackMutableState(definition);
  return buildEnvMetaFromLayers(
    definition,
    mutableState,
    await readRepoUrlForEnvDefinition(env, definition),
  );
}

export async function listEnvViews(env: Env): Promise<EnvMeta[]> {
  const slugs = await listEnvDefinitionSlugs(env);
  const entries = await Promise.all(slugs.map(async (slug) => {
    try {
      return await loadEnvView(env, slug);
    } catch (error) {
      console.warn(
        `[envs] Skipping invalid env ${slug}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }));
  return entries
    .filter((entry): entry is EnvMeta => entry !== null)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function envExists(env: Env, slug: string): Promise<boolean> {
  try {
    return (await readEnvDefinition(env, slug)) !== null;
  } catch {
    return false;
  }
}
