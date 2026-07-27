import type { Env } from "../types";
import { parseCanonicalWorkersDevHostname } from "../canonical-workers-dev";

export function resolveWorkerServiceNameFromHostname(
  hostname: string,
): string | null {
  try {
    return parseCanonicalWorkersDevHostname(hostname).serviceName;
  } catch {
    return null;
  }
}

/**
 * Update operations derive the Worker service only from the canonical
 * workers.dev request. Retired persisted service names and custom origins are
 * deliberately ignored.
 */
export async function resolveWorkerServiceName(
  _env: Env,
  requestUrl: string,
): Promise<string | null> {
  return resolveWorkerServiceNameFromHostname(new URL(requestUrl).hostname);
}
