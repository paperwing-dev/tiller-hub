export function requiresWorkersDevAccessProtection(options: {
  isLocalDev: boolean;
  accessConfigured: boolean;
}): boolean {
  return !options.isLocalDev
    && !options.accessConfigured;
}
