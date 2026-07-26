import { KIMI_K2_7_CODE } from "../shared/harness-catalog";

export const PLAN_DEFAULT_MODEL = "gpt-5.5";

export const PLAN_MODEL_OPTIONS = [
  { id: "gpt-5.5", label: "ChatGPT 5.5" },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 120B" },
  { id: KIMI_K2_7_CODE.providerModel, label: KIMI_K2_7_CODE.label },
] as const;

export type PlanModelId = (typeof PLAN_MODEL_OPTIONS)[number]["id"];

export function isPlanModelId(value: string | null): value is PlanModelId {
  return PLAN_MODEL_OPTIONS.some((option) => option.id === value);
}

export function isChatGPTPlanModel(value: string | null | undefined): value is "gpt-5.5" {
  return value === "gpt-5.5";
}

export function getFallbackPlanModel(): PlanModelId {
  return PLAN_MODEL_OPTIONS.find((option) => !isChatGPTPlanModel(option.id))?.id ?? PLAN_DEFAULT_MODEL;
}

export function coercePlanModelSelection(
  selectedModel: PlanModelId,
  options: { chatgptAvailable: boolean },
): PlanModelId {
  if (!options.chatgptAvailable && isChatGPTPlanModel(selectedModel)) {
    return getFallbackPlanModel();
  }

  return selectedModel;
}

export function getPlanModelLabel(id: string | undefined): string {
  return PLAN_MODEL_OPTIONS.find((option) => option.id === id)?.label ?? id ?? "Unknown model";
}
