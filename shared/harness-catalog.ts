import type {
  EnvHarness,
  HarnessEffort,
  HarnessModelId,
  HarnessSettings,
} from "../api/types";
import {
  billingSelectionForCredential,
  resolveBillingCompatibility,
  type BillingMode,
  type BillingSelections,
  type ProviderControlledCredentialClass,
} from "./billing";

export const HARNESS_CREDENTIAL_REQUIREMENTS = [
  "codex-auth",
  "claude-auth",
  "anthropic-api-key",
  "openai-api-key",
  "workers-ai",
] as const;
export type HarnessCredentialRequirement = (typeof HARNESS_CREDENTIAL_REQUIREMENTS)[number];

export const HARNESS_PROVIDER_KINDS = [
  "codex",
  "claude",
  "anthropic",
  "openai",
  "cloudflare-workers-ai",
] as const;
export type HarnessProviderKind = (typeof HARNESS_PROVIDER_KINDS)[number];

export function isHarnessCredentialRequirement(
  value: string | null | undefined,
): value is HarnessCredentialRequirement {
  return typeof value === "string"
    && (HARNESS_CREDENTIAL_REQUIREMENTS as readonly string[]).includes(value);
}

export function isHarnessProviderKind(value: string | null | undefined): value is HarnessProviderKind {
  return typeof value === "string" && (HARNESS_PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface HarnessModelCatalogEntry {
  id: HarnessModelId;
  label: string;
  harness: EnvHarness;
  efforts: readonly HarnessEffort[];
  limits: {
    readonly context: number;
    readonly input?: number;
    readonly output: number;
  };
  supportsFastMode?: boolean;
  credential: HarnessCredentialRequirement;
  binding:
    | { kind: "codex"; model: string; providerLabel: string }
    | { kind: "claude"; model: string; providerLabel: string }
    | {
        kind: "opencode";
        provider: "openai" | "anthropic" | "cloudflare-workers-ai";
        providerAlias: string;
        providerLabel: string;
        modelAlias: string;
        model: string;
        baseUrl: string | null;
      };
}

const LOW_TO_XHIGH = ["low", "medium", "high", "xhigh"] as const;
const LOW_TO_MAX = ["low", "medium", "high", "xhigh", "max"] as const;
const LOW_TO_MAX_AND_ULTRA = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const LOW_TO_HIGH = ["low", "medium", "high"] as const;
// Direct-provider token limits projected into custom OpenCode models. Keep
// these catalog-owned so every launch surface uses the same compaction budget.
const OPENAI_LIMITS = { context: 1_050_000, input: 922_000, output: 128_000 } as const;
const ANTHROPIC_LIMITS = { context: 1_000_000, output: 128_000 } as const;
const KIMI_K2_7_LIMITS = { context: 262_144, output: 262_144 } as const;

export const KIMI_K2_7_CODE = {
  id: "kimi-k2.7-code",
  label: "Kimi K2.7 Code",
  providerModel: "@cf/moonshotai/kimi-k2.7-code",
} as const satisfies {
  id: HarnessModelId;
  label: string;
  providerModel: string;
};

export const HARNESS_MODEL_CATALOG: readonly HarnessModelCatalogEntry[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    harness: "codex",
    efforts: LOW_TO_MAX_AND_ULTRA,
    limits: OPENAI_LIMITS,
    supportsFastMode: true,
    credential: "codex-auth",
    binding: { kind: "codex", model: "gpt-5.6-sol", providerLabel: "Codex" },
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    harness: "codex",
    efforts: LOW_TO_XHIGH,
    limits: OPENAI_LIMITS,
    supportsFastMode: true,
    credential: "codex-auth",
    binding: { kind: "codex", model: "gpt-5.5", providerLabel: "Codex" },
  },
  {
    id: "claude-opus-4.8",
    label: "Opus 4.8",
    harness: "claude-code",
    efforts: LOW_TO_MAX,
    limits: ANTHROPIC_LIMITS,
    supportsFastMode: true,
    credential: "claude-auth",
    binding: { kind: "claude", model: "claude-opus-4-8", providerLabel: "Claude" },
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    harness: "claude-code",
    efforts: LOW_TO_MAX,
    limits: ANTHROPIC_LIMITS,
    credential: "anthropic-api-key",
    binding: { kind: "claude", model: "claude-fable-5", providerLabel: "Claude" },
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    harness: "opencode",
    efforts: LOW_TO_MAX_AND_ULTRA,
    limits: OPENAI_LIMITS,
    credential: "openai-api-key",
    binding: {
      kind: "opencode",
      provider: "openai",
      providerAlias: "tiller-openai",
      providerLabel: "OpenAI",
      modelAlias: "gpt-5-6-sol",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
    },
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    harness: "opencode",
    efforts: LOW_TO_XHIGH,
    limits: OPENAI_LIMITS,
    credential: "openai-api-key",
    binding: {
      kind: "opencode",
      provider: "openai",
      providerAlias: "tiller-openai",
      providerLabel: "OpenAI",
      modelAlias: "gpt-5-5",
      model: "gpt-5.5",
      baseUrl: "https://api.openai.com/v1",
    },
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    harness: "opencode",
    efforts: LOW_TO_MAX,
    limits: ANTHROPIC_LIMITS,
    credential: "anthropic-api-key",
    binding: {
      kind: "opencode",
      provider: "anthropic",
      providerAlias: "tiller-anthropic",
      providerLabel: "Anthropic",
      modelAlias: "claude-opus-5",
      model: "claude-opus-5",
      baseUrl: "https://api.anthropic.com/v1",
    },
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    harness: "opencode",
    efforts: LOW_TO_MAX,
    limits: ANTHROPIC_LIMITS,
    credential: "anthropic-api-key",
    binding: {
      kind: "opencode",
      provider: "anthropic",
      providerAlias: "tiller-anthropic",
      providerLabel: "Anthropic",
      modelAlias: "claude-fable-5",
      model: "claude-fable-5",
      baseUrl: "https://api.anthropic.com/v1",
    },
  },
  {
    id: KIMI_K2_7_CODE.id,
    label: KIMI_K2_7_CODE.label,
    harness: "opencode",
    efforts: LOW_TO_HIGH,
    limits: KIMI_K2_7_LIMITS,
    credential: "workers-ai",
    binding: {
      kind: "opencode",
      provider: "cloudflare-workers-ai",
      providerAlias: "tiller-hub",
      providerLabel: "Tiller Hub",
      modelAlias: "tiller-kimi-k2-7-code",
      model: KIMI_K2_7_CODE.providerModel,
      baseUrl: null,
    },
  },
] as const;

const HARNESS_DEFAULTS: Record<EnvHarness, HarnessSettings> = {
  codex: { model: "gpt-5.6-sol", effort: "xhigh" },
  "claude-code": { model: "claude-opus-4.8", effort: "xhigh" },
  opencode: { model: KIMI_K2_7_CODE.id, effort: "high" },
};

export function listHarnessModels(harness: EnvHarness): readonly HarnessModelCatalogEntry[] {
  return HARNESS_MODEL_CATALOG.filter((entry) => entry.harness === harness);
}

export function getHarnessModel(
  harness: EnvHarness,
  model: HarnessModelId,
): HarnessModelCatalogEntry | null {
  return HARNESS_MODEL_CATALOG.find((entry) => entry.harness === harness && entry.id === model) ?? null;
}

export function getHarnessDefault(harness: EnvHarness): HarnessSettings {
  return { ...HARNESS_DEFAULTS[harness] };
}

export function isHarnessSettings(value: unknown): value is HarnessSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HarnessSettings>;
  if (typeof candidate.model !== "string" || typeof candidate.effort !== "string") return false;
  if (candidate.fastMode !== undefined && typeof candidate.fastMode !== "boolean") return false;
  return HARNESS_MODEL_CATALOG.some(
    (entry) => entry.id === candidate.model && entry.efforts.includes(candidate.effort as HarnessEffort),
  );
}

export function validateHarnessSettings(
  harness: EnvHarness,
  value: unknown,
): HarnessSettings | null {
  if (!isHarnessSettings(value)) return null;
  const entry = getHarnessModel(harness, value.model);
  return entry?.efforts.includes(value.effort)
    && !(value.fastMode && !entry.supportsFastMode)
    ? {
        model: value.model,
        effort: value.effort,
        ...(value.fastMode ? { fastMode: true } : {}),
      }
    : null;
}

export function resolveHarnessSettings(
  harness: EnvHarness,
  submitted: unknown,
  committed?: HarnessSettings | null,
): HarnessSettings {
  if (submitted !== undefined) {
    const validated = validateHarnessSettings(harness, submitted);
    if (!validated) throw new Error("harnessSettings must contain a model and effort supported by the environment harness");
    return validated;
  }
  return validateHarnessSettings(harness, committed) ?? getHarnessDefault(harness);
}

export function retainOrClampEffort(
  harness: EnvHarness,
  model: HarnessModelId,
  currentEffort: HarnessEffort,
): HarnessEffort {
  const entry = getHarnessModel(harness, model);
  if (!entry) return getHarnessDefault(harness).effort;
  return entry.efforts.includes(currentEffort)
    ? currentEffort
    : entry.efforts[entry.efforts.length - 1];
}

export interface HarnessCredentialStatus {
  hasClaudeSubscription?: boolean;
  hasAnthropicKey?: boolean;
  hasChatGPTAuth?: boolean;
  hasOpenAIKey?: boolean;
  workersAiConfigured?: boolean;
  claudeBillingMode?: BillingMode | null;
  openaiBillingMode?: BillingMode | null;
  chatgptAuthStatus?: "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
  /** Live backend, runtime compatibility, and runtime-auth checks for the selected subscription route. */
  openaiSubscriptionReady?: boolean;
  openaiSubscriptionUnavailableReason?: string | null;
}

export interface HarnessModelAvailability {
  available: boolean;
  requirement: HarnessCredentialRequirement;
  message: string | null;
}

export function resolveHarnessModelAvailability(
  entry: HarnessModelCatalogEntry,
  backend: "cf" | "host",
  status: HarnessCredentialStatus,
): HarnessModelAvailability {
  if (entry.credential === "workers-ai") {
    const available = Boolean(status.workersAiConfigured);
    return {
      available,
      requirement: entry.credential,
      message: available ? null : "Requires Workers AI.",
    };
  }

  const credential = entry.credential as ProviderControlledCredentialClass;
  const selections: BillingSelections = {
    claudeBillingMode: status.claudeBillingMode ?? null,
    openaiBillingMode: status.openaiBillingMode ?? null,
  };
  const selectedMode = billingSelectionForCredential(credential, selections);
  const compatibility = resolveBillingCompatibility(credential, selectedMode);
  const providerLabel = credential === "claude-auth" || credential === "anthropic-api-key"
    ? "Claude"
    : "OpenAI";
  if (compatibility.kind === "billing-mode-unselected") {
    return {
      available: false,
      requirement: entry.credential,
      message: `Select a billing mode for ${providerLabel} in Global Settings.`,
    };
  }
  if (compatibility.kind === "incompatible-billing-mode") {
    return {
      available: false,
      requirement: entry.credential,
      message: credential === "anthropic-api-key"
        ? `${entry.label} requires Claude API mode.`
        : `${entry.label} requires OpenAI API mode.`,
    };
  }

  let available: boolean;
  let message: string | null;
  if (providerLabel === "Claude") {
    available = compatibility.mode === "subscription"
      ? Boolean(status.hasClaudeSubscription)
      : Boolean(status.hasAnthropicKey);
    message = available
      ? null
      : compatibility.mode === "subscription"
        ? "Configure the active Claude subscription token in Global Settings."
        : "Configure the active Claude API key in Global Settings.";
  } else if (compatibility.mode === "api") {
    available = Boolean(status.hasOpenAIKey);
    message = available ? null : "Configure the active OpenAI API key in Global Settings.";
  } else {
    const connected = status.chatgptAuthStatus
      ? status.chatgptAuthStatus === "connected" || status.chatgptAuthStatus === "refreshing"
      : Boolean(status.hasChatGPTAuth);
    const routeReady = status.openaiSubscriptionReady !== false;
    available = routeReady && connected;
    message = available
      ? null
      : !routeReady
        ? status.openaiSubscriptionUnavailableReason
          ?? `The active OpenAI subscription route is not ready for ${backend === "host" ? "Your machine" : "Cloudflare Containers"}.`
        : status.chatgptAuthStatus === "temporarily_unavailable"
          ? "The active OpenAI subscription is temporarily unavailable."
          : "Connect the active OpenAI subscription in Global Settings.";
  }
  return {
    available,
    requirement: entry.credential,
    message,
  };
}

/** Resolve planner aliases and provider-native model ids through the catalog. */
export function getPlannerModelCredentialRequirement(
  providerId: string,
  modelId: string,
): HarnessCredentialRequirement | null {
  if (providerId === "claude-code" && (modelId === "sonnet" || modelId === "opus")) {
    return "claude-auth";
  }
  const harness: EnvHarness | null = providerId === "codex"
    ? "codex"
    : providerId === "claude-code"
      ? "claude-code"
      : providerId === "opencode"
        ? "opencode"
        : null;
  if (!harness) return null;
  return listHarnessModels(harness).find((entry) => (
    entry.id === modelId || entry.binding.model === modelId
  ))?.credential ?? null;
}

export function hasAvailableHarnessModel(
  harnesses: readonly EnvHarness[],
  backend: "cf" | "host",
  status: HarnessCredentialStatus,
): boolean {
  return harnesses.some((harness) =>
    listHarnessModels(harness).some(
      (entry) => resolveHarnessModelAvailability(entry, backend, status).available,
    ));
}

export function listHarnessModelRequirementMessages(
  harnesses: readonly EnvHarness[],
  backend: "cf" | "host",
  status: HarnessCredentialStatus,
): string[] {
  const messages = new Set<string>();
  for (const harness of harnesses) {
    for (const entry of listHarnessModels(harness)) {
      const availability = resolveHarnessModelAvailability(entry, backend, status);
      if (availability.message) messages.add(availability.message);
    }
  }
  return [...messages];
}

export function isSolModel(model: HarnessModelId): boolean {
  return model === "gpt-5.6-sol";
}
