import { getEnvLifecycleStub } from "../helpers";
import type { Env, EnvMeta } from "../types";
import {
  getEnvDefinitionKey,
  listEnvDefinitionSlugs,
  readEnvDefinition,
} from "../plan/store";

export async function loadEnvView(env: Env, slug: string): Promise<EnvMeta | null> {
  const definition = await readEnvDefinition(env, slug);
  if (!definition) {
    return null;
  }
  const lifecycle = getEnvLifecycleStub(env, slug);
  const owned = await lifecycle.getOwnedEnvView();
  if (!owned || owned.incarnationId !== definition.incarnationId) return null;
  return owned;
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
  const definition = await readEnvDefinition(env, slug);
  if (!definition) return false;
  return Boolean(
    await getEnvLifecycleStub(env, slug).peekVisibleMutableState(definition.incarnationId!),
  );
}

export async function envSlugReserved(env: Env, slug: string): Promise<boolean> {
  // The definition is removed only after lifecycle deletion finalizes, so it
  // remains the slug reservation even while the environment is hidden.
  return Boolean(await env.ENVS_KV.get(getEnvDefinitionKey(slug)));
}
