import type { HarnessEffort } from "../types";
import type { ResolvedOpenCodeContainerAuth } from "../env/container-auth";
import type { HarnessModelCatalogEntry } from "../../shared/harness-catalog";

export function buildOpenCodeRuntimeEnv(options: {
  model: HarnessModelCatalogEntry;
  auth: ResolvedOpenCodeContainerAuth;
  proxyBaseUrl: string;
  reasoningEffort?: HarnessEffort;
}): Record<string, string> {
  const { model, auth } = options;
  if (model.binding.kind !== "opencode") {
    throw new Error(`Model ${model.id} is not an OpenCode model.`);
  }

  return {
    TILLER_OPENCODE_BASE_URL: auth.baseUrl ?? options.proxyBaseUrl,
    TILLER_OPENCODE_AUTH_TOKEN: auth.token,
    TILLER_OPENCODE_MODEL_ID: auth.model,
    TILLER_OPENCODE_MODEL_ALIAS: model.binding.modelAlias,
    TILLER_OPENCODE_MODEL_LABEL: model.label,
    TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: String(model.limits.context),
    ...(model.limits.input
      ? { TILLER_OPENCODE_MODEL_INPUT_LIMIT: String(model.limits.input) }
      : {}),
    TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: String(model.limits.output),
    TILLER_OPENCODE_PROVIDER_KIND: model.binding.provider,
    TILLER_OPENCODE_PROVIDER_ALIAS: model.binding.providerAlias,
    TILLER_OPENCODE_PROVIDER_LABEL: model.binding.providerLabel,
    ...(options.reasoningEffort
      ? { TILLER_OPENCODE_REASONING_EFFORT: options.reasoningEffort }
      : {}),
  };
}
