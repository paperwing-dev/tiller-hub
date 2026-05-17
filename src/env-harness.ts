import type { EnvHarness, EnvMeta, LeadHarnessStatus } from "../api/types";

export function getHarnessBadgeLabel(harness: EnvHarness): string {
  return harness === "codex"
    ? "Codex"
    : harness === "opencode"
      ? "Open Code"
      : "Claude Code";
}

export function getHarnessBadgeClass(harness: EnvHarness): string {
  return harness === "codex"
    ? "border-sky-200 bg-sky-50 text-sky-700"
    : harness === "opencode"
      ? "border-teal-200 bg-teal-50 text-teal-700"
      : "border-orange-200 bg-orange-50 text-orange-700";
}

export function getEnvAuthBadge(
  env: Pick<EnvMeta, "harness" | "resolvedAuthMode" | "authMode" | "codexAuthMode" | "opencodeProvider">,
): { label: string; className: string } | null {
  const { harness } = env;

  if (harness === "codex") {
    return {
      label: env.codexAuthMode === "subscription" ? "Subscription" : "API key",
      className: env.codexAuthMode === "subscription"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-sky-200 bg-sky-50 text-sky-700",
    };
  }

  if (harness === "opencode") {
    return null;
  }

  if (!env.resolvedAuthMode) return null;

  return {
    label: env.resolvedAuthMode === "api" ? "API key" : "Subscription",
    className: env.resolvedAuthMode === "api"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700",
  };
}

export function getEnvModelBadge(
  _env: Pick<EnvMeta, "harness" | "opencodeModel">,
): { label: string; className: string } | null {
  return null;
}

export function getLeadHarnessBadge(
  _env: Pick<EnvMeta, "leadHarnessStatus">,
): { label: string; className: string } | null {
  return null;
}
