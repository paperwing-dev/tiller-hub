export function isEnabledFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function isLoopbackUrl(url: string | URL): boolean {
  try {
    const parsed = url instanceof URL ? url : new URL(url);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isLocalDevMode(options: {
  enabled?: string | null;
  url?: string | URL | null;
}): boolean {
  return isEnabledFlag(options.enabled) && Boolean(options.url && isLoopbackUrl(options.url));
}
