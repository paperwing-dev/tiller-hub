import type { RouteKind } from "./config";

export function requiresWorkersDevAccessProtection(options: {
  isLocalDev: boolean;
  currentRouteKind: RouteKind;
  accessConfigured: boolean;
}): boolean {
  return !options.isLocalDev
    && options.currentRouteKind === "workers-dev"
    && !options.accessConfigured;
}
