import { getBillingSelections, getSecret } from "../setup/config";
import { inspectPlannerExecution } from "./dispatch";
import type { PlannerExecution } from "./dispatch";
import { PLANNER_OPENCODE_MODEL } from "./opencode-model";
import {
  getPlannerModelCredentialRequirement,
  listHarnessModels,
  resolveHarnessModelAvailability,
} from "../../shared/harness-catalog";
import {
  billingSelectionForCredential,
  resolveBillingCompatibility,
  type ProviderControlledCredentialClass,
} from "../../shared/billing";
import type { Env } from "../types";
import type {
  PlannerEffort,
  PlannerProviderCapabilities,
  PlannerProviderEffort,
  PlannerProviderMetadata,
  PlannerProviderModel,
  AgentRoute,
} from "../coordination";
import { listWriterAgentRoutes } from "./agent-skills";

const STANDARD_EFFORTS: PlannerProviderEffort[] = [
  { id: "low", displayName: "Low" },
  { id: "medium", displayName: "Medium" },
  { id: "high", displayName: "High" },
];

const CODEX_EFFORTS: PlannerProviderEffort[] = [
  ...STANDARD_EFFORTS,
  { id: "xhigh", displayName: "Extra High" },
  { id: "max", displayName: "Max" },
  { id: "ultra", displayName: "Ultra" },
];

const CLAUDE_EFFORTS: PlannerProviderEffort[] = [
  ...STANDARD_EFFORTS,
  { id: "xhigh", displayName: "Extra High" },
  { id: "max", displayName: "Max" },
];

// Claude Code and Codex provide both the long-lived Plan Writer native TUI
// adapter and disposable reviewer runs. Reviewer continuity belongs to the
// persisted Tiller thread; each provider execution remains one-shot.
const PLAN_WRITER_PROVIDER_CAPABILITIES: PlannerProviderCapabilities = {
  writer: true,
  reviewer: true,
  chatContinuation: true,
  cancellation: true,
  planDelta: false,
  checklist: false,
};

const REVIEWER_ONLY_PROVIDER_CAPABILITIES: PlannerProviderCapabilities = {
  writer: false,
  reviewer: true,
  chatContinuation: true,
  cancellation: true,
  planDelta: true,
  checklist: true,
};

const OPENCODE_PROVIDER_CAPABILITIES: PlannerProviderCapabilities = {
  ...REVIEWER_ONLY_PROVIDER_CAPABILITIES,
  writer: true,
};

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function isFakePlannerProviderEnabled(env: Env): boolean {
  return isEnabled(env.TILLER_ENABLE_FAKE_PLANNER_PROVIDER) || isEnabled(env.LOCAL_DEV_ONLY_BACKEND);
}

function model(
  id: string,
  displayName: string,
  options: {
    available: boolean;
    authStatus: PlannerProviderModel["authStatus"];
    disabledReason?: string;
    efforts?: readonly PlannerEffort[];
  },
): PlannerProviderModel {
  const efforts = options.efforts?.map((effort) => ({
    id: effort,
    displayName: effort === "xhigh"
      ? "Extra High"
      : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`,
  }));
  const defaultEffort = options.efforts?.includes("xhigh")
    ? "xhigh"
    : options.efforts?.includes("high")
      ? "high"
      : options.efforts?.[options.efforts.length - 1];
  return {
    id,
    displayName,
    available: options.available,
    authStatus: options.authStatus,
    ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
    ...(efforts?.length ? { efforts, defaultEffort } : {}),
  };
}

function provider(options: {
  id: string;
  displayName: string;
  available: boolean;
  authStatus: PlannerProviderMetadata["authStatus"];
  disabledReasons?: string[];
  capabilities: PlannerProviderCapabilities;
  models: PlannerProviderModel[];
  efforts: PlannerProviderEffort[];
  defaultEffort: PlannerEffort;
}): PlannerProviderMetadata {
  return {
    id: options.id,
    displayName: options.displayName,
    available: options.available,
    authStatus: options.authStatus,
    disabledReasons: options.disabledReasons ?? [],
    capabilities: options.capabilities,
    models: options.models,
    efforts: options.efforts,
    defaultEffort: options.defaultEffort,
  };
}

export async function listPlannerProviders(
  env: Env,
  options: { onlyProviderId?: string } = {},
): Promise<{
  providers: PlannerProviderMetadata[];
  writerRoutes: AgentRoute[];
  executions: Record<string, PlannerExecution>;
}> {
  const onlyProviderId = options.onlyProviderId;
  const billingSelections = onlyProviderId === "fake"
    ? { claudeBillingMode: null, openaiBillingMode: null }
    : await getBillingSelections(env);
  const showDevelopmentProviders = isFakePlannerProviderEnabled(env);
  const notEvaluated = (providerId: string): PlannerExecution => ({
    kind: "unavailable",
    reason: `${providerId} was not evaluated.`,
  });
  const resolveIfRequested = (providerId: string) => (
    !onlyProviderId || onlyProviderId === providerId
      // Catalog availability must keep Plan Writer usable while protected
      // reviewer rollout is gated. Reviewer creation revalidates its own
      // surface immediately before reservation.
      ? inspectPlannerExecution(env, providerId, { billingSelections, codexSurface: "plan-writer" })
      : Promise.resolve(notEvaluated(providerId))
  );
  const [codexExecution, claudeExecution, opencodeExecution] = await Promise.all([
    resolveIfRequested("codex"),
    resolveIfRequested("claude-code"),
    resolveIfRequested("opencode"),
  ]);
  const codexAvailable = codexExecution.kind === "dispatched";
  const codexDisabledReason = codexExecution.kind === "unavailable" ? codexExecution.reason : undefined;
  const claudeAvailable = claudeExecution.kind === "dispatched";
  const claudeDisabledReason = claudeExecution.kind === "unavailable" ? claudeExecution.reason : undefined;
  const opencodeAvailable = opencodeExecution.kind === "dispatched";
  const opencodeDisabledReason = opencodeExecution.kind === "unavailable" ? opencodeExecution.reason : undefined;
  const hasSecret = async (name: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY"): Promise<boolean> => {
    const direct = (env as unknown as Record<string, unknown>)[name];
    if (typeof direct === "string" && direct.trim()) return true;
    return Boolean((await getSecret(env, name, { fresh: true }))?.trim());
  };
  const [hasAnthropicKey, hasOpenAIKey, workersAiConfigured] = await Promise.all([
    hasSecret("ANTHROPIC_API_KEY"),
    hasSecret("OPENAI_API_KEY"),
    Promise.all([
      (env as unknown as { AI?: unknown }).AI ? Promise.resolve(true) : Promise.resolve(false),
      getSecret(env, "TILLER_WORKERS_AI_ACCOUNT_ID", { fresh: true }).then((value) => Boolean(value?.trim())),
      getSecret(env, "TILLER_WORKERS_AI_API_TOKEN", { fresh: true }).then((value) => Boolean(value?.trim())),
    ]).then(([binding, accountId, token]) => binding || (accountId && token)),
  ]);
  const claudeModel = (id: string, displayName: string) => model(id, displayName, {
    available: claudeAvailable,
    authStatus: claudeAvailable ? "available" : "missing",
    disabledReason: claudeDisabledReason,
  });
  const catalogModel = (
    entry: ReturnType<typeof listHarnessModels>[number],
    providerAvailable: boolean,
    providerDisabledReason: string | undefined,
  ) => {
    if (entry.credential === "workers-ai") {
      return model(entry.binding.model, entry.label, {
        available: providerAvailable,
        authStatus: providerAvailable ? "available" : "missing",
        disabledReason: providerDisabledReason,
        efforts: entry.efforts,
      });
    }
    const credential = entry.credential as ProviderControlledCredentialClass;
    const compatibility = resolveBillingCompatibility(
      credential,
      billingSelectionForCredential(credential, billingSelections),
    );
    const compatible = compatibility.kind === "compatible";
    const disabledReason = compatibility.kind === "billing-mode-unselected"
      ? `Select a billing mode for ${entry.harness === "claude-code" ? "Claude" : "OpenAI"} in Global Settings.`
      : compatibility.kind === "incompatible-billing-mode"
        ? `${entry.label} requires ${entry.harness === "claude-code" ? "Claude" : "OpenAI"} API mode.`
        : providerDisabledReason;
    return model(entry.binding.model, entry.label, {
      available: providerAvailable && compatible,
      authStatus: providerAvailable && compatible ? "available" : "missing",
      disabledReason,
      efforts: entry.efforts,
    });
  };
  const openCodeWriterModels = listHarnessModels("opencode").map((entry) => {
    const availability = resolveHarnessModelAvailability(
      entry,
      opencodeExecution.kind === "dispatched" ? opencodeExecution.backend : "cf",
      {
        hasAnthropicKey,
        hasOpenAIKey,
        workersAiConfigured,
        claudeBillingMode: billingSelections.claudeBillingMode,
        openaiBillingMode: billingSelections.openaiBillingMode,
      },
    );
    const available = opencodeAvailable && availability.available;
    return model(entry.binding.model, entry.label, {
      available,
      authStatus: available ? "available" : "missing",
      disabledReason: opencodeDisabledReason ?? availability.message ?? undefined,
      efforts: entry.efforts,
    });
  });

  const providers: PlannerProviderMetadata[] = [
    provider({
      id: "codex",
      displayName: "Codex",
      available: codexAvailable,
      authStatus: codexAvailable ? "available" : "missing",
      disabledReasons: codexDisabledReason ? [codexDisabledReason] : [],
      capabilities: PLAN_WRITER_PROVIDER_CAPABILITIES,
      efforts: CODEX_EFFORTS,
      defaultEffort: "xhigh",
      models: [
        ...listHarnessModels("codex").map((entry) => catalogModel(entry, codexAvailable, codexDisabledReason)),
      ],
    }),
    provider({
      id: "claude-code",
      displayName: "Claude Code",
      available: claudeAvailable,
      authStatus: claudeAvailable ? "available" : "missing",
      disabledReasons: claudeDisabledReason ? [claudeDisabledReason] : [],
      capabilities: PLAN_WRITER_PROVIDER_CAPABILITIES,
      efforts: CLAUDE_EFFORTS,
      defaultEffort: "high",
      // CLI model aliases on purpose: they track the latest model of each tier
      // without re-pinning provider metadata on every model release. Sonnet
      // first — it is the right default speed for plan writing.
      models: [
        // Keep concise native aliases available for Plan Writer launches.
        // Reviewer and Plan Skill routes also expose catalog-owned bindings.
        claudeModel("sonnet", "Claude Sonnet 4.6"),
        claudeModel("opus", "Claude Opus 4.8"),
        ...listHarnessModels("claude-code").map((entry) => catalogModel(entry, claudeAvailable, claudeDisabledReason)),
      ],
    }),
    provider({
      id: "opencode",
      displayName: "OpenCode",
      // Provider-level availability reflects runtime support. Credential
      // availability remains route-specific on the projected catalog models.
      available: opencodeAvailable,
      authStatus: "available",
      disabledReasons: opencodeDisabledReason ? [opencodeDisabledReason] : [],
      capabilities: OPENCODE_PROVIDER_CAPABILITIES,
      efforts: STANDARD_EFFORTS,
      defaultEffort: "high",
      models: openCodeWriterModels.filter((candidate) => (
        candidate.id === PLANNER_OPENCODE_MODEL.binding.model
      )),
    }),
  ];

  if (showDevelopmentProviders) {
    providers.push(provider({
      id: "fake",
      displayName: "Fake Planner",
      available: true,
      authStatus: "available",
      capabilities: REVIEWER_ONLY_PROVIDER_CAPABILITIES,
      efforts: STANDARD_EFFORTS,
      defaultEffort: "medium",
      models: [
        model("fake-fast", "Fake Fast", {
          available: true,
          authStatus: "available",
        }),
      ],
    }));
  }

  // Writer projection gets every OpenCode catalog binding. The public provider
  // models remain Kimi-only so reviewer and Plan Skill model menus do not grow.
  const writerProviders = providers.map((entry) => entry.id === "opencode"
    ? { ...entry, models: openCodeWriterModels }
    : entry);
  const writerRoutes = listWriterAgentRoutes(writerProviders);

  return {
    providers: onlyProviderId
      ? providers.filter((candidate) => candidate.id === onlyProviderId)
      : providers,
    writerRoutes: onlyProviderId
      ? writerRoutes.filter((route) => route.provider === onlyProviderId)
      : writerRoutes,
    executions: {
      codex: codexExecution,
      "claude-code": claudeExecution,
      opencode: opencodeExecution,
      ...(showDevelopmentProviders ? { fake: { kind: "in-process" as const } } : {}),
    },
  };
}

/** Static catalog validation that deliberately performs no billing or health reads. */
export function isKnownPlannerProviderModel(providerId: string, modelId: string): boolean {
  if (providerId === "fake") return modelId === "fake-fast";
  if (providerId === "opencode") return modelId === PLANNER_OPENCODE_MODEL.binding.model;
  return getPlannerModelCredentialRequirement(providerId, modelId) !== null;
}

export function findPlannerProviderModel(
  providers: PlannerProviderMetadata[],
  providerId: string,
  modelId: string,
): { provider: PlannerProviderMetadata; model: PlannerProviderModel } | null {
  const providerMetadata = providers.find((candidate) => candidate.id === providerId);
  const modelMetadata = providerMetadata?.models.find((candidate) => candidate.id === modelId);
  return providerMetadata && modelMetadata ? { provider: providerMetadata, model: modelMetadata } : null;
}

export function findPlannerProviderEffort(
  provider: PlannerProviderMetadata,
  effort: string,
  model?: PlannerProviderModel,
): PlannerProviderEffort | null {
  const efforts = model?.efforts?.length ? model.efforts : provider.efforts;
  return efforts.find((candidate) => candidate.id === effort) ?? null;
}

export function getPlannerProviderModelDefaultEffort(
  provider: PlannerProviderMetadata,
  model: PlannerProviderModel,
): PlannerEffort {
  const efforts = model.efforts?.length ? model.efforts : provider.efforts;
  const preferred = model.defaultEffort ?? provider.defaultEffort;
  return efforts.some((effort) => effort.id === preferred)
    ? preferred
    : efforts[0]?.id ?? provider.defaultEffort;
}
