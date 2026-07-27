const WORKERS_DEV_SUFFIX = ".workers.dev";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface CanonicalWorkersDevRoute {
  hostname: string;
  origin: string;
  serviceName: string;
  workersDevSubdomain: string;
}

/**
 * The single parser for a production Worker route. A valid route contains a
 * Worker service label and an account subdomain before workers.dev.
 */
export function parseCanonicalWorkersDevHostname(
  hostnameInput: string,
): CanonicalWorkersDevRoute {
  const hostname = hostnameInput.trim().toLowerCase().replace(/\.$/, "");
  const labels = hostname.endsWith(WORKERS_DEV_SUFFIX)
    ? hostname.slice(0, -WORKERS_DEV_SUFFIX.length).split(".")
    : [];
  if (
    labels.length < 2
    || labels.some((label) => !DNS_LABEL.test(label))
  ) {
    throw new Error(
      "Could not determine the Worker name and workers.dev account subdomain from this route.",
    );
  }
  return {
    hostname,
    origin: `https://${hostname}`,
    serviceName: labels[0]!,
    workersDevSubdomain: labels.slice(1).join("."),
  };
}

export function normalizeCanonicalWorkersDevHostname(value: string): string {
  try {
    return parseCanonicalWorkersDevHostname(value).hostname;
  } catch {
    return "";
  }
}
