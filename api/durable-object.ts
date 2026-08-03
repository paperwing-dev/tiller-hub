import { isPlacementRegion } from "../shared/placement";
import type { Env } from "./types";

type LocationEnv = Pick<Env, "DO_LOCATION_HINT">;

type NamedDurableObjectNamespace = Pick<
  DurableObjectNamespace,
  "getByName" | "idFromName" | "get"
>;

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
  const options = durableObjectOptions(env);
  if (typeof namespace.getByName === "function") {
    return namespace.getByName(name, options) as T;
  }
  // Keep existing namespace test doubles compatible while production uses the
  // built-in named lookup above.
  const id = namespace.idFromName(name);
  return namespace.get(id, options) as T;
}
