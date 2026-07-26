export const BILLING_MODES = ["subscription", "api"] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

export interface BillingSelections {
  claudeBillingMode: BillingMode | null;
  openaiBillingMode: BillingMode | null;
}

export type ProviderControlledCredentialClass =
  | "claude-auth"
  | "anthropic-api-key"
  | "codex-auth"
  | "openai-api-key";

export type BillingCompatibility =
  | { kind: "compatible"; mode: BillingMode }
  | { kind: "billing-mode-unselected" }
  | { kind: "incompatible-billing-mode" };

export function normalizeBillingMode(value: unknown): BillingMode | null {
  return value === "subscription" || value === "api" ? value : null;
}

export function normalizeBillingSelections(input: {
  claudeBillingMode?: unknown;
  openaiBillingMode?: unknown;
}): BillingSelections {
  return {
    claudeBillingMode: normalizeBillingMode(input.claudeBillingMode),
    openaiBillingMode: normalizeBillingMode(input.openaiBillingMode),
  };
}

/**
 * Resolve catalog policy only. Credential presence and runtime/backend health
 * are deliberately composed by callers after this succeeds.
 */
export function resolveBillingCompatibility(
  credential: ProviderControlledCredentialClass,
  selectedMode: BillingMode | null,
): BillingCompatibility {
  if (!selectedMode) return { kind: "billing-mode-unselected" };
  if (
    selectedMode === "subscription"
    && (credential === "anthropic-api-key" || credential === "openai-api-key")
  ) {
    return { kind: "incompatible-billing-mode" };
  }
  return { kind: "compatible", mode: selectedMode };
}

export function billingSelectionForCredential(
  credential: ProviderControlledCredentialClass,
  selections: BillingSelections,
): BillingMode | null {
  return credential === "claude-auth" || credential === "anthropic-api-key"
    ? selections.claudeBillingMode
    : selections.openaiBillingMode;
}
