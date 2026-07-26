import type { EnvHarness, EnvMeta, LeadHarnessStatus } from "../api/types";
import { getHarnessModel } from "../shared/harness-catalog";

export function getHarnessBadgeLabel(harness: EnvHarness): string {
  return harness === "codex"
    ? "Codex"
    : harness === "opencode"
      ? "Open Code"
      : "Claude Code";
}

export function getHarnessBadgeClass(harness: EnvHarness): string {
  return harness === "codex"
    ? "border-kumo-info/30 bg-kumo-info-tint text-kumo-info"
    : harness === "opencode"
      ? "border-kumo-badge-teal/30 bg-kumo-badge-teal/10 text-kumo-badge-teal"
      : "border-kumo-badge-orange/40 bg-kumo-badge-orange/10 text-kumo-badge-orange";
}

export function getEnvAuthBadge(
  env: Pick<EnvMeta, "harness" | "resolvedAuthMode" | "codexAuthMode">,
): { label: string; className: string } | null {
  const { harness } = env;

  if (harness === "codex") {
    if (!env.codexAuthMode) return null;
    return {
      label: env.codexAuthMode === "subscription" ? "Subscription" : "API key",
      className: env.codexAuthMode === "subscription"
        ? "border-kumo-success/30 bg-kumo-success-tint text-kumo-success"
        : "border-kumo-info/30 bg-kumo-info-tint text-kumo-info",
    };
  }

  if (harness === "opencode") {
    return null;
  }

  if (!env.resolvedAuthMode) return null;

  return {
    label: env.resolvedAuthMode === "api" ? "API key" : "Subscription",
    className: env.resolvedAuthMode === "api"
      ? "border-kumo-warning/40 bg-kumo-warning-tint text-kumo-warning"
      : "border-kumo-success/30 bg-kumo-success-tint text-kumo-success",
  };
}

export function getEnvModelBadge(
  env: Pick<EnvMeta, "harness" | "harnessSettings">,
): { label: string; className: string } | null {
  const label = getEnvModelLabel(env);
  return label
    ? { label, className: "border-kumo-line bg-kumo-base text-kumo-subtle" }
    : null;
}

export function getEnvModelLabel(
  env: Pick<EnvMeta, "harness" | "harnessSettings">,
): string | null {
  if (!env.harnessSettings) return null;
  return getHarnessModel(env.harness, env.harnessSettings.model)?.label ?? null;
}

export function getLeadHarnessBadge(
  _env: Pick<EnvMeta, "leadHarnessStatus">,
): { label: string; className: string } | null {
  return null;
}
