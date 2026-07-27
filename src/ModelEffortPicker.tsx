import React from "react";
import { Select } from "@cloudflare/kumo/components/select";

export interface ModelEffortOption<Effort extends string = string> {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  efforts: Array<{ value: Effort; label: string }>;
  defaultEffort: Effort;
}

export interface ModelEffortSelection<Effort extends string = string> {
  model: string;
  effort: Effort;
}

interface ModelEffortPickerProps<Effort extends string> {
  options: ModelEffortOption<Effort>[];
  value: ModelEffortSelection<Effort>;
  onChange: (value: ModelEffortSelection<Effort>) => void;
  disabled?: boolean;
  className?: string;
  modelLabel?: string;
  effortLabel?: string;
}

export default function ModelEffortPicker<Effort extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className = "",
  modelLabel = "Model",
  effortLabel = "Effort",
}: ModelEffortPickerProps<Effort>) {
  const selected = options.find((option) => option.value === value.model) ?? null;

  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_8.5rem] gap-3 ${className}`.trim()}>
      <div className="min-w-0 text-xs font-medium text-kumo-subtle">
        <span className="mb-1.5 block">{modelLabel}</span>
        <Select
          aria-label={modelLabel}
          className="w-full"
          size="sm"
          value={value.model}
          onValueChange={(nextValue) => {
            if (!nextValue) return;
            const nextOption = options.find((option) => option.value === nextValue);
            if (!nextOption) return;
            const effort = nextOption.efforts.some((candidate) => candidate.value === value.effort)
              ? value.effort
              : nextOption.defaultEffort;
            onChange({ model: nextOption.value, effort });
          }}
          disabled={disabled || options.length === 0}
          renderValue={(selectedValue) =>
            options.find((option) => option.value === selectedValue)?.label ?? String(selectedValue)
          }
        >
          {options.map((option) => (
            <Select.Option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
              {option.description ? ` — ${option.description}` : ""}
              {option.disabled && option.disabledReason ? ` — ${option.disabledReason}` : ""}
            </Select.Option>
          ))}
        </Select>
      </div>

      <div className="text-xs font-medium text-kumo-subtle">
        <span className="mb-1.5 block">{effortLabel}</span>
        <Select
          aria-label={effortLabel}
          className="w-full"
          size="sm"
          value={value.effort}
          onValueChange={(nextValue) => {
            if (!nextValue || !selected) return;
            const effort = selected.efforts.find((candidate) => candidate.value === nextValue);
            if (effort) onChange({ ...value, effort: effort.value });
          }}
          disabled={disabled || !selected || selected.efforts.length === 0}
          renderValue={(selectedValue) =>
            selected?.efforts.find((effort) => effort.value === selectedValue)?.label ?? String(selectedValue)
          }
        >
          {(selected?.efforts ?? []).map((effort) => (
            <Select.Option key={effort.value} value={effort.value}>{effort.label}</Select.Option>
          ))}
        </Select>
      </div>
    </div>
  );
}
