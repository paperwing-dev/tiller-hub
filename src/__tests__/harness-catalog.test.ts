import { describe, expect, it } from "vitest";
import {
  getHarnessDefault,
  getHarnessModel,
  getPlannerModelCredentialRequirement,
  hasAvailableHarnessModel,
  HARNESS_MODEL_CATALOG,
  listHarnessModelRequirementMessages,
  listHarnessModels,
  resolveHarnessModelAvailability,
  resolveHarnessSettings,
  retainOrClampEffort,
  validateHarnessSettings,
} from "../../shared/harness-catalog";
import { resolveBillingCompatibility } from "../../shared/billing";

describe("harness catalog", () => {
  it("owns the exact model order, effort arrays, and defaults", () => {
    expect(listHarnessModels("codex").map(({ id, efforts }) => [id, efforts])).toEqual([
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
      ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
    ]);
    expect(listHarnessModels("claude-code").map(({ id, efforts }) => [id, efforts])).toEqual([
      ["claude-opus-4.8", ["low", "medium", "high", "xhigh", "max"]],
      ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
    ]);
    expect(listHarnessModels("opencode").map(({ id, efforts }) => [id, efforts])).toEqual([
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
      ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
      ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
      ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
      ["kimi-k2.7-code", ["low", "medium", "high"]],
    ]);
    expect(getHarnessDefault("codex")).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
    expect(getHarnessDefault("claude-code")).toEqual({ model: "claude-opus-4.8", effort: "xhigh" });
    expect(getHarnessDefault("opencode")).toEqual({ model: "kimi-k2.7-code", effort: "high" });
  });

  it("locks every credential requirement and exact runtime binding", () => {
    expect(HARNESS_MODEL_CATALOG.map(({ harness, id, credential, binding }) => ({
      harness,
      id,
      credential,
      binding,
    }))).toEqual([
      {
        harness: "codex",
        id: "gpt-5.6-sol",
        credential: "codex-auth",
        binding: { kind: "codex", model: "gpt-5.6-sol", providerLabel: "Codex" },
      },
      {
        harness: "codex",
        id: "gpt-5.5",
        credential: "codex-auth",
        binding: { kind: "codex", model: "gpt-5.5", providerLabel: "Codex" },
      },
      {
        harness: "claude-code",
        id: "claude-opus-4.8",
        credential: "claude-auth",
        binding: { kind: "claude", model: "claude-opus-4-8", providerLabel: "Claude" },
      },
      {
        harness: "claude-code",
        id: "claude-fable-5",
        credential: "anthropic-api-key",
        binding: { kind: "claude", model: "claude-fable-5", providerLabel: "Claude" },
      },
      {
        harness: "opencode",
        id: "gpt-5.6-sol",
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
        harness: "opencode",
        id: "gpt-5.5",
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
        harness: "opencode",
        id: "claude-opus-5",
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
        harness: "opencode",
        id: "claude-fable-5",
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
        harness: "opencode",
        id: "kimi-k2.7-code",
        credential: "workers-ai",
        binding: {
          kind: "opencode",
          provider: "cloudflare-workers-ai",
          providerAlias: "tiller-hub",
          providerLabel: "Tiller Hub",
          modelAlias: "tiller-kimi-k2-7-code",
          model: "@cf/moonshotai/kimi-k2.7-code",
          baseUrl: null,
        },
      },
    ]);
  });

  it("owns non-zero context and output limits for every model", () => {
    expect(HARNESS_MODEL_CATALOG.every(({ limits }) => (
      Number.isSafeInteger(limits.context)
      && limits.context > 0
      && Number.isSafeInteger(limits.output)
      && limits.output > 0
      && (limits.input === undefined || (Number.isSafeInteger(limits.input) && limits.input > 0))
    ))).toBe(true);
    expect(listHarnessModels("opencode").map(({ id, limits }) => ({ id, limits }))).toEqual([
      { id: "gpt-5.6-sol", limits: { context: 1_050_000, input: 922_000, output: 128_000 } },
      { id: "gpt-5.5", limits: { context: 1_050_000, input: 922_000, output: 128_000 } },
      { id: "claude-opus-5", limits: { context: 1_000_000, output: 128_000 } },
      { id: "claude-fable-5", limits: { context: 1_000_000, output: 128_000 } },
      { id: "kimi-k2.7-code", limits: { context: 262_144, output: 262_144 } },
    ]);
  });

  it("validates complete harness-specific pairs and defaults only omitted input", () => {
    expect(validateHarnessSettings("opencode", { model: "gpt-5.5", effort: "xhigh" })).toEqual({
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(validateHarnessSettings("codex", { model: "kimi-k2.7-code", effort: "high" })).toBeNull();
    expect(validateHarnessSettings("codex", { model: "gpt-5.5" })).toBeNull();
    expect(validateHarnessSettings("codex", {
      model: "gpt-5.5",
      effort: "high",
      ignored: { nested: true },
    })).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(validateHarnessSettings("codex", {
      model: "gpt-5.5",
      effort: "high",
      fastMode: true,
    })).toEqual({ model: "gpt-5.5", effort: "high", fastMode: true });
    expect(validateHarnessSettings("claude-code", {
      model: "claude-opus-4.8",
      effort: "high",
      fastMode: true,
    })).toEqual({ model: "claude-opus-4.8", effort: "high", fastMode: true });
    expect(validateHarnessSettings("claude-code", {
      model: "claude-fable-5",
      effort: "high",
      fastMode: true,
    })).toBeNull();
    expect(validateHarnessSettings("opencode", {
      model: "gpt-5.5",
      effort: "high",
      fastMode: true,
    })).toBeNull();
    expect(validateHarnessSettings("opencode", {
      model: "claude-opus-5",
      effort: "max",
      fastMode: true,
    })).toBeNull();
    expect(validateHarnessSettings("codex", {
      model: "gpt-5.5",
      effort: "high",
      fastMode: "yes",
    })).toBeNull();
    expect(() => resolveHarnessSettings("codex", { model: "gpt-5.5" })).toThrow(/model and effort/);
    expect(resolveHarnessSettings("codex", undefined, { model: "gpt-5.5", effort: "high" })).toEqual({
      model: "gpt-5.5",
      effort: "high",
    });
  });

  it("retains supported effort and otherwise clamps to the target maximum", () => {
    expect(retainOrClampEffort("opencode", "gpt-5.5", "medium")).toBe("medium");
    expect(retainOrClampEffort("opencode", "kimi-k2.7-code", "max")).toBe("high");
    expect(retainOrClampEffort("codex", "gpt-5.5", "ultra")).toBe("xhigh");
  });

  it("resolves selected-route credential and backend readiness", () => {
    const codex = getHarnessModel("codex", "gpt-5.6-sol")!;
    expect(resolveHarnessModelAvailability(codex, "host", {
      openaiBillingMode: "subscription",
      hasChatGPTAuth: true,
      chatgptAuthStatus: "connected",
      openaiSubscriptionReady: true,
    })).toMatchObject({
      available: true,
      requirement: "codex-auth",
    });
    expect(resolveHarnessModelAvailability(codex, "host", {
      openaiBillingMode: "subscription",
      hasChatGPTAuth: true,
      chatgptAuthStatus: "connected",
      openaiSubscriptionReady: false,
      openaiSubscriptionUnavailableReason: "Self Host runtime is offline.",
    })).toMatchObject({
      available: false,
      requirement: "codex-auth",
      message: "Self Host runtime is offline.",
    });
    expect(resolveHarnessModelAvailability(codex, "host", {
      openaiBillingMode: "subscription",
      chatgptAuthStatus: "refreshing",
      openaiSubscriptionReady: true,
    })).toMatchObject({
      available: true,
      requirement: "codex-auth",
      message: null,
    });
    for (const chatgptAuthStatus of ["missing", "needs_reconnect", "temporarily_unavailable"] as const) {
      expect(resolveHarnessModelAvailability(codex, "host", {
        openaiBillingMode: "subscription",
        hasOpenAIKey: true,
        chatgptAuthStatus,
        openaiSubscriptionReady: true,
      })).toMatchObject({
        available: false,
        requirement: "codex-auth",
      });
      expect(resolveHarnessModelAvailability(codex, "host", {
        openaiBillingMode: "subscription",
        hasOpenAIKey: true,
        chatgptAuthStatus,
        openaiSubscriptionReady: true,
      }).message).not.toContain("API key");
    }
    expect(resolveHarnessModelAvailability(codex, "host", {
      openaiBillingMode: "subscription",
      hasOpenAIKey: true,
      chatgptAuthStatus: "missing",
      openaiSubscriptionReady: false,
      openaiSubscriptionUnavailableReason: "Self Host runtime is offline.",
    })).toMatchObject({
      available: false,
      message: "Self Host runtime is offline.",
    });
    const fable = getHarnessModel("claude-code", "claude-fable-5")!;
    expect(resolveHarnessModelAvailability(fable, "host", {
      claudeBillingMode: "subscription",
      hasClaudeSubscription: true,
    })).toMatchObject({
      available: false,
      requirement: "anthropic-api-key",
      message: "Fable 5 requires Claude API mode.",
    });
    expect(resolveHarnessModelAvailability(fable, "cf", {
      claudeBillingMode: "api",
      hasAnthropicKey: true,
    })).toMatchObject({
      available: true,
      requirement: "anthropic-api-key",
    });
    const openCodeGpt = getHarnessModel("opencode", "gpt-5.6-sol")!;
    expect(resolveHarnessModelAvailability(openCodeGpt, "host", {
      openaiBillingMode: "subscription",
      hasChatGPTAuth: true,
      chatgptAuthStatus: "connected",
    })).toMatchObject({
      available: false,
      requirement: "openai-api-key",
      message: "GPT-5.6 Sol requires OpenAI API mode.",
    });
    const openCodeOpus = getHarnessModel("opencode", "claude-opus-5")!;
    expect(resolveHarnessModelAvailability(openCodeOpus, "host", {
      claudeBillingMode: "subscription",
      hasClaudeSubscription: true,
    })).toMatchObject({
      available: false,
      requirement: "anthropic-api-key",
      message: "Opus 5 requires Claude API mode.",
    });
    expect(resolveHarnessModelAvailability(openCodeOpus, "cf", {
      claudeBillingMode: "api",
      hasAnthropicKey: true,
    })).toMatchObject({
      available: true,
      requirement: "anthropic-api-key",
      message: null,
    });
    const kimi = getHarnessModel("opencode", "kimi-k2.7-code")!;
    expect(resolveHarnessModelAvailability(kimi, "cf", { workersAiConfigured: true })).toMatchObject({
      available: true,
      requirement: "workers-ai",
    });
  });

  it("derives enabled-harness readiness and guidance from catalog models", () => {
    expect(hasAvailableHarnessModel(["opencode"], "cf", {
      openaiBillingMode: "api",
      hasOpenAIKey: true,
    })).toBe(true);
    expect(hasAvailableHarnessModel(["opencode"], "host", {
      claudeBillingMode: "api",
      hasAnthropicKey: true,
    })).toBe(true);
    expect(hasAvailableHarnessModel(["opencode"], "cf", { workersAiConfigured: true })).toBe(true);
    expect(hasAvailableHarnessModel(["opencode"], "cf", {})).toBe(false);
    expect(listHarnessModelRequirementMessages(["opencode"], "cf", {})).toEqual([
      "Select a billing mode for OpenAI in Global Settings.",
      "Select a billing mode for Claude in Global Settings.",
      "Requires Workers AI.",
    ]);
  });

  it("exhaustively resolves catalog credential classes without a fallback", () => {
    expect(resolveBillingCompatibility("claude-auth", null)).toEqual({ kind: "billing-mode-unselected" });
    expect(resolveBillingCompatibility("claude-auth", "subscription")).toEqual({ kind: "compatible", mode: "subscription" });
    expect(resolveBillingCompatibility("claude-auth", "api")).toEqual({ kind: "compatible", mode: "api" });
    expect(resolveBillingCompatibility("anthropic-api-key", "subscription")).toEqual({ kind: "incompatible-billing-mode" });
    expect(resolveBillingCompatibility("anthropic-api-key", "api")).toEqual({ kind: "compatible", mode: "api" });
    expect(resolveBillingCompatibility("codex-auth", null)).toEqual({ kind: "billing-mode-unselected" });
    expect(resolveBillingCompatibility("codex-auth", "subscription")).toEqual({ kind: "compatible", mode: "subscription" });
    expect(resolveBillingCompatibility("codex-auth", "api")).toEqual({ kind: "compatible", mode: "api" });
    expect(resolveBillingCompatibility("openai-api-key", "subscription")).toEqual({ kind: "incompatible-billing-mode" });
    expect(resolveBillingCompatibility("openai-api-key", "api")).toEqual({ kind: "compatible", mode: "api" });
  });

  it("maps planner aliases through the catalog and rejects unknown models before billing", () => {
    expect(getPlannerModelCredentialRequirement("claude-code", "sonnet")).toBe("claude-auth");
    expect(getPlannerModelCredentialRequirement("claude-code", "opus")).toBe("claude-auth");
    expect(getPlannerModelCredentialRequirement("claude-code", "claude-fable-5")).toBe("anthropic-api-key");
    expect(getPlannerModelCredentialRequirement("codex", "gpt-5.6-sol")).toBe("codex-auth");
    expect(getPlannerModelCredentialRequirement("opencode", "claude-opus-5")).toBe("anthropic-api-key");
    expect(getPlannerModelCredentialRequirement("opencode", "@cf/moonshotai/kimi-k2.7-code")).toBe("workers-ai");
    expect(getPlannerModelCredentialRequirement("claude-code", "unknown")).toBeNull();
  });
});
