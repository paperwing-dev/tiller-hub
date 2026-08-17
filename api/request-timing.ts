import type { Context, MiddlewareHandler } from "hono";
import type { ApiRequestTiming, HonoEnv } from "./types";

const DEFAULT_SLOW_REQUEST_MS = 2_000;

export interface ApiSlowRequestWarning {
  event: "slow_api_request";
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
  phases: Record<string, number>;
}

interface ApiTimingMiddlewareOptions {
  now?: () => number;
  slowRequestMs?: number;
  warn?: (warning: ApiSlowRequestWarning) => void;
}

function roundedDuration(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function serverTimingValue(timing: ApiRequestTiming, totalMs: number): string {
  return [
    ...timing.phases.map((phase) => `${phase.name};dur=${phase.durationMs.toFixed(1)}`),
    `total;dur=${totalMs.toFixed(1)}`,
  ].join(", ");
}

export function createApiTimingMiddleware(
  options: ApiTimingMiddlewareOptions = {},
): MiddlewareHandler<HonoEnv> {
  const now = options.now ?? (() => performance.now());
  const slowRequestMs = options.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS;
  const warn = options.warn ?? ((warning) => console.warn(warning));

  return async (c, next) => {
    if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
      await next();
      return;
    }

    const timing: ApiRequestTiming = { startedAt: now(), phases: [] };
    c.set("apiRequestTiming", timing);
    await next();

    const contentType = c.res.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) return;

    const totalMs = roundedDuration(now() - timing.startedAt);
    c.header("Server-Timing", serverTimingValue(timing, totalMs), { append: true });
    if (totalMs <= slowRequestMs) return;

    warn({
      event: "slow_api_request",
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: totalMs,
      phases: Object.fromEntries(timing.phases.map((phase) => [phase.name, phase.durationMs])),
    });
  };
}

export function recordApiTimingPhase(
  c: Context<HonoEnv>,
  name: string,
  startedAt: number,
): void {
  const timing = c.get("apiRequestTiming");
  if (!timing) return;
  timing.phases.push({
    name,
    durationMs: roundedDuration(performance.now() - startedAt),
  });
}
