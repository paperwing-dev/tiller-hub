export const CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES = 15;
export const CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES = 1;
export const CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES = 1440;

export function isCloudflareIdleTimeoutMinutes(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES
    && value <= CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES;
}

export function normalizeCloudflareIdleTimeoutMinutes(value: unknown): number {
  const parsed = typeof value === "string" && value.trim()
    ? Number(value)
    : value;
  return isCloudflareIdleTimeoutMinutes(parsed)
    ? parsed
    : CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES;
}
