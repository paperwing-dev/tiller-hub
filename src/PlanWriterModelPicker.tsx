import React from "react";
import type { AgentRoute, PlannerEffort, PlannerProviderMetadata } from "./api";
import ModelEffortPicker, { type ModelEffortOption } from "./ModelEffortPicker";
import { PLAN_AGENT_LABEL } from "./plan-agent-copy";

export interface PlanWriterModelSelection {
  routeKey: string;
  effort: PlannerEffort;
}

interface PlanWriterModelPickerProps {
  routes: AgentRoute[];
  providers: PlannerProviderMetadata[];
  value: PlanWriterModelSelection;
  onChange: (value: PlanWriterModelSelection) => void;
  settingsHref?: string;
  disabled?: boolean;
  className?: string;
}

const EFFORT_LABELS: Record<PlannerEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultra: "Ultra",
  max: "Max",
};

export function planWriterEffortLabel(effort: PlannerEffort | null | undefined): string {
  return effort ? EFFORT_LABELS[effort] : "Default";
}

export function buildPlanWriterModelOptions(
  routes: AgentRoute[],
  providers: PlannerProviderMetadata[],
): ModelEffortOption<PlannerEffort>[] {
  const providerLabels = new Map(providers.map((provider) => [provider.id, provider.displayName]));
  return routes.map((route) => ({
    value: route.key,
    label: route.label,
    description: providerLabels.get(route.provider) ?? route.provider,
    disabled: !route.available,
    disabledReason: route.disabledReason,
    efforts: route.supportedEfforts.map((effort) => ({
      value: effort,
      label: EFFORT_LABELS[effort],
    })),
    defaultEffort: route.defaultEffort,
  }));
}

export default function PlanWriterModelPicker({
  routes,
  providers,
  value,
  onChange,
  settingsHref,
  disabled = false,
  className,
}: PlanWriterModelPickerProps) {
  return (
    <div className={className}>
      <ModelEffortPicker
        options={buildPlanWriterModelOptions(routes, providers)}
        value={{ model: value.routeKey, effort: value.effort }}
        onChange={(selection) => onChange({ routeKey: selection.model, effort: selection.effort })}
        disabled={disabled}
        modelLabel={`${PLAN_AGENT_LABEL} model`}
        effortLabel="Reasoning effort"
      />
      {settingsHref && (
        <p className="mt-2 text-xs text-kumo-subtle">
          <a
            href={settingsHref}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-kumo-link underline underline-offset-2 hover:no-underline"
          >
            Open model access settings
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
    </div>
  );
}
