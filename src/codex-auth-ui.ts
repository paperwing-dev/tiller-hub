import type { CodexAuthMode } from "../api/types";

export function codexAuthModeLabel(mode: CodexAuthMode): string {
  return mode === "subscription" ? "Subscription" : "API key";
}
