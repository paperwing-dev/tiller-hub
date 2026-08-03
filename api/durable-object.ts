import { isPlacementRegion } from "../shared/placement";
import type { Env } from "./types";

type LocationEnv = Pick<Env, "DO_LOCATION_HINT">;

interface NamedDurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ): unknown;
}

/** Fail closed on altered placement bindings before a new Durable Object can be created globally. */
export function durableObjectOptions(
  env: LocationEnv | undefined,
): DurableObjectNamespaceGetDurableObjectOptions {
  const value = env?.DO_LOCATION_HINT;
  if (value === undefined) return {};
  if (!isPlacementRegion(value)) {
    throw new Error("DO_LOCATION_HINT is invalid");
  }
  return { locationHint: value };
}

/** The only production constructor for named Durable Object stubs. */
export function getDurableObjectStub<T>(
  env: LocationEnv,
  namespace: NamedDurableObjectNamespace,
  name: string,
): T {
  const id = namespace.idFromName(name);
  return namespace.get(id, durableObjectOptions(env)) as T;
}
