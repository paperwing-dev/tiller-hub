import type { EnvHarness, HarnessEffort, HarnessModelId, HarnessSettings } from "../api/types";
import {
  getHarnessModel,
  listHarnessModels,
  resolveHarnessModelAvailability,
  type HarnessCredentialStatus,
} from "../shared/harness-catalog";
import ModelEffortPicker, { type ModelEffortOption } from "./ModelEffortPicker";
import FastModeField from "./FastModeField";

interface HarnessSettingsFieldsProps {
  harness: EnvHarness;
  backend: "cf" | "host";
  value: HarnessSettings;
  credentialStatus: HarnessCredentialStatus;
  disabled?: boolean;
  className?: string;
  onChange: (value: HarnessSettings) => void;
}

export default function HarnessSettingsFields({
  harness,
  backend,
  value,
  credentialStatus,
  disabled = false,
  className,
  onChange,
}: HarnessSettingsFieldsProps) {
  const models = listHarnessModels(harness);
  const selectedModel = getHarnessModel(harness, value.model);
  const selectedAvailability = selectedModel
    ? resolveHarnessModelAvailability(selectedModel, backend, credentialStatus)
    : null;
  const options: ModelEffortOption<HarnessEffort>[] = models.map((model) => {
    const availability = resolveHarnessModelAvailability(model, backend, credentialStatus);
    return {
      value: model.id,
      label: model.label,
      description: model.binding.providerLabel,
      disabled: !availability.available,
      disabledReason: availability.message ?? undefined,
      efforts: model.efforts.map((effort) => ({ value: effort, label: effort })),
      defaultEffort: model.efforts[model.efforts.length - 1] ?? "high",
    };
  });

  return (
    <div className={className}>
      <ModelEffortPicker<HarnessEffort>
        options={options}
        value={{ model: value.model, effort: value.effort }}
        disabled={disabled}
        onChange={(nextValue) => {
          onChange({
            model: nextValue.model as HarnessModelId,
            effort: nextValue.effort,
            ...(value.fastMode ? { fastMode: true } : {}),
          });
        }}
      />

      {harness === "codex" && (
        <FastModeField
          className="mt-3"
          checked={Boolean(value.fastMode)}
          disabled={disabled}
          onChange={(fastMode) => onChange({
            model: value.model,
            effort: value.effort,
            ...(fastMode ? { fastMode: true } : {}),
          })}
        />
      )}

      {selectedAvailability?.message && (
        <p data-testid="harness-model-requirement" className="mt-2 text-xs text-kumo-danger">
          {selectedAvailability.message}
        </p>
      )}
    </div>
  );
}
