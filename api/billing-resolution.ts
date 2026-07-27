import type { HarnessModelCatalogEntry } from "../shared/harness-catalog";
import type { BillingCompatibility } from "../shared/billing";

export type BillingResolutionFailureReason =
  | "billing-mode-unselected"
  | "incompatible-billing-mode"
  | "credential-not-configured";

export class BillingResolutionError extends Error {
  readonly reason: BillingResolutionFailureReason;

  constructor(reason: BillingResolutionFailureReason, message: string) {
    super(message);
    this.name = "BillingResolutionError";
    this.reason = reason;
  }
}

export function createBillingResolutionError(
  entry: HarnessModelCatalogEntry,
  kind: Exclude<BillingCompatibility["kind"], "compatible">,
): BillingResolutionError {
  const provider = entry.credential === "claude-auth" || entry.credential === "anthropic-api-key"
    ? "Claude"
    : "OpenAI";
  if (kind === "billing-mode-unselected") {
    return new BillingResolutionError(
      "billing-mode-unselected",
      `Select a billing mode for ${provider} in Global Settings.`,
    );
  }
  return new BillingResolutionError(
    "incompatible-billing-mode",
    entry.credential === "anthropic-api-key"
      ? `${entry.label} requires Claude API mode.`
      : `${entry.label} requires OpenAI API mode.`,
  );
}
