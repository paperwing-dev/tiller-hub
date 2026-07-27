import React from "react";
import type { AgentRoute, PlannerEffort, PlannerProviderMetadata } from "./api";
import ModelEffortPicker, { type ModelEffortOption } from "./ModelEffortPicker";
import FastModeField from "./FastModeField";

export interface PlanWriterModelSelection {
  routeKey: string;
  effort: PlannerEffort;
  fastMode?: boolean;
}

interface PlanWriterModelPickerProps {
  routes: AgentRoute[];
  providers: PlannerProviderMetadata[];
  value: PlanWriterModelSelection;
  onChange: (value: PlanWriterModelSelection) => void;
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

export function planWriterRouteSupportsFastMode(routes: AgentRoute[], routeKey: string): boolean {
  return routes.some((route) => route.key === routeKey && route.provider === "codex");
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
  disabled = false,
  className,
}: PlanWriterModelPickerProps) {
  const selectedRouteSupportsFastMode = planWriterRouteSupportsFastMode(routes, value.routeKey);
  return (
    <div className={className}>
      <ModelEffortPicker
        options={buildPlanWriterModelOptions(routes, providers)}
        value={{ model: value.routeKey, effort: value.effort }}
        onChange={(selection) => {
          const nextRoute = routes.find((route) => route.key === selection.model) ?? null;
          onChange({
            routeKey: selection.model,
            effort: selection.effort,
            ...(nextRoute?.provider === "codex" && value.fastMode ? { fastMode: true } : {}),
          });
        }}
        disabled={disabled}
        modelLabel="Writer model"
        effortLabel="Reasoning effort"
      />
      {selectedRouteSupportsFastMode && (
        <FastModeField
          className="mt-3"
          checked={Boolean(value.fastMode)}
          disabled={disabled}
          onChange={(fastMode) => onChange({
            routeKey: value.routeKey,
            effort: value.effort,
            ...(fastMode ? { fastMode: true } : {}),
          })}
        />
      )}
    </div>
  );
}
