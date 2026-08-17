import { useEffect, useRef } from "react";
import type {
  EnvHarness,
  HarnessEffort,
  HarnessModelId,
  HarnessSettings,
} from "../api/types";
import {
  getHarnessModel,
  listHarnessModels,
  resolveHarnessModelAvailability,
  type HarnessCredentialStatus,
  type HarnessCredentialRequirement,
} from "../shared/harness-catalog";
import ModelEffortPicker, { type ModelEffortOption } from "./ModelEffortPicker";
import FastModeField from "./FastModeField";
import {
  SETTINGS_TARGET_IDS,
  settingsTargetHref,
  type SettingsTargetId,
} from "./settings-targets";

interface HarnessRequirementSettingsLink {
  target: SettingsTargetId;
  label: string;
}

export function getHarnessRequirementSettingsLink(
  requirement: HarnessCredentialRequirement,
  status: HarnessCredentialStatus,
): HarnessRequirementSettingsLink | null {
  switch (requirement) {
    case "claude-auth":
      return status.claudeBillingMode === "subscription"
        ? {
            target: SETTINGS_TARGET_IDS.claudeSubscription,
            label: "Open Claude subscription settings",
          }
        : {
            target: SETTINGS_TARGET_IDS.claudeBilling,
            label: "Open Claude billing settings",
          };
    case "anthropic-api-key":
      return status.claudeBillingMode === "api"
        ? {
            target: SETTINGS_TARGET_IDS.claudeApiKey,
            label: "Open Claude API key settings",
          }
        : {
            target: SETTINGS_TARGET_IDS.claudeBilling,
            label: "Open Claude billing settings",
          };
    case "codex-auth":
      if (status.openaiBillingMode !== "subscription") {
        return {
          target: SETTINGS_TARGET_IDS.openaiBilling,
          label: "Open OpenAI billing settings",
        };
      }
      if (status.openaiSubscriptionReady === false) {
        return {
          target: SETTINGS_TARGET_IDS.executionBackend,
          label: "Open execution settings",
        };
      }
      return {
        target: SETTINGS_TARGET_IDS.codexSubscription,
        label: "Open Codex subscription settings",
      };
    case "openai-api-key":
      return status.openaiBillingMode === "api"
        ? {
            target: SETTINGS_TARGET_IDS.openaiApiKey,
            label: "Open OpenAI API key settings",
          }
        : {
            target: SETTINGS_TARGET_IDS.openaiBilling,
            label: "Open OpenAI billing settings",
          };
    case "workers-ai":
      return null;
  }
}

interface HarnessSettingsFieldsProps {
  harness: EnvHarness;
  backend: "cf" | "host";
  value: HarnessSettings;
  credentialStatus: HarnessCredentialStatus;
  disabled?: boolean;
  showFastMode?: boolean;
  className?: string;
  settingsPath?: string;
  onRefreshSettings?: () => Promise<void>;
  onChange: (value: HarnessSettings) => void;
}

export default function HarnessSettingsFields({
  harness,
  backend,
  value,
  credentialStatus,
  disabled = false,
  showFastMode = true,
  className,
  settingsPath,
  onRefreshSettings,
  onChange,
}: HarnessSettingsFieldsProps) {
  const settingsOpenedRef = useRef(false);
  const models = listHarnessModels(harness);
  const selectedModel = getHarnessModel(harness, value.model);
  const selectedAvailability = selectedModel
    ? resolveHarnessModelAvailability(selectedModel, backend, credentialStatus)
    : null;
  const selectedModelSupportsFastMode = selectedModel?.supportsFastMode === true;
  const options: ModelEffortOption<HarnessEffort>[] = models.map((model) => {
    const availability = resolveHarnessModelAvailability(
      model,
      backend,
      credentialStatus,
    );
    return {
      value: model.id,
      label: model.label,
      description: model.binding.providerLabel,
      disabled: !availability.available,
      disabledReason: availability.message ?? undefined,
      efforts: model.efforts.map((effort) => ({
        value: effort,
        label: effort,
      })),
      defaultEffort: model.efforts[model.efforts.length - 1] ?? "high",
    };
  });
  const requirementLink =
    selectedAvailability?.message && selectedModel && settingsPath
      ? getHarnessRequirementSettingsLink(
          selectedModel.credential,
          credentialStatus,
        )
      : null;
  const requirementHref =
    requirementLink && settingsPath
      ? settingsTargetHref(settingsPath, requirementLink.target)
      : null;

  useEffect(() => {
    if (!onRefreshSettings) return;
    const handleFocus = () => {
      if (!settingsOpenedRef.current) return;
      settingsOpenedRef.current = false;
      void onRefreshSettings();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [onRefreshSettings]);

  return (
    <div className={className}>
      <ModelEffortPicker<HarnessEffort>
        options={options}
        value={{ model: value.model, effort: value.effort }}
        disabled={disabled}
        onChange={(nextValue) => {
          const nextModel = getHarnessModel(harness, nextValue.model as HarnessModelId);
          onChange({
            model: nextValue.model as HarnessModelId,
            effort: nextValue.effort,
            ...(value.fastMode && nextModel?.supportsFastMode ? { fastMode: true } : {}),
          });
        }}
      />

      {showFastMode && selectedModelSupportsFastMode && (
        <FastModeField
          className="mt-3"
          checked={Boolean(value.fastMode)}
          disabled={disabled}
          onChange={(fastMode) =>
            onChange({
              model: value.model,
              effort: value.effort,
              ...(fastMode ? { fastMode: true } : {}),
            })
          }
        />
      )}

      {selectedAvailability?.message && (
        <p
          data-testid="harness-model-requirement"
          className="mt-2 text-xs text-kumo-danger"
        >
          {selectedAvailability.message}
          {requirementLink && requirementHref && (
            <>
              {" "}
              <a
                href={requirementHref}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  settingsOpenedRef.current = true;
                }}
                className="font-medium text-kumo-link underline underline-offset-2 hover:no-underline"
              >
                {requirementLink.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
