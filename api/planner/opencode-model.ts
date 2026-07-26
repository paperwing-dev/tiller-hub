import {
  getHarnessModel,
  KIMI_K2_7_CODE,
  type HarnessModelCatalogEntry,
} from "../../shared/harness-catalog";

type OpenCodeBinding = Extract<HarnessModelCatalogEntry["binding"], { kind: "opencode" }>;
export type PlannerOpenCodeModel = Omit<HarnessModelCatalogEntry, "binding"> & {
  binding: OpenCodeBinding;
};

function resolvePlannerOpenCodeModel(): PlannerOpenCodeModel {
  const model = getHarnessModel("opencode", KIMI_K2_7_CODE.id);
  if (!model || model.binding.kind !== "opencode") {
    throw new Error("The planner OpenCode model is missing from the harness catalog.");
  }
  return model as PlannerOpenCodeModel;
}

export const PLANNER_OPENCODE_MODEL = resolvePlannerOpenCodeModel();
