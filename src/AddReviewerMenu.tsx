import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import type { PlannerEffort, PlannerProviderMetadata } from "./api";
import ModelEffortPicker, { type ModelEffortOption } from "./ModelEffortPicker";

export type AddReviewerAction = {
  kind: "tab";
  provider: string;
  model: string;
  effort: PlannerEffort;
};

interface ReviewerModelOption extends ModelEffortOption<PlannerEffort> {
  provider: string;
  model: string;
}

interface AddReviewerMenuProps {
  activeReviewerCount: number;
  providers: PlannerProviderMetadata[];
  disabled?: boolean;
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAdd: (input: AddReviewerAction) => void;
}

export default function AddReviewerMenu({
  activeReviewerCount,
  providers,
  disabled = false,
  label = "Add reviewer",
  open: controlledOpen,
  onOpenChange,
  onAdd,
}: AddReviewerMenuProps) {
  const options = useMemo(() => buildReviewerModelOptions(providers), [providers]);
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [selection, setSelection] = useState<{ model: string; effort: PlannerEffort }>(() => ({
    model: enabledOptions[0]?.value ?? "",
    effort: enabledOptions[0]?.defaultEffort ?? "high",
  }));

  useEffect(() => {
    if (enabledOptions.some((option) => option.value === selection.model)) return;
    const first = enabledOptions[0];
    if (first) setSelection({ model: first.value, effort: first.defaultEffort });
  }, [enabledOptions, selection.model]);

  if (activeReviewerCount >= 4) {
    return (
      <Button size="sm" disabled title="Reviewer limit reached">
        {label}
      </Button>
    );
  }

  const selected = options.find((option) => option.value === selection.model) ?? null;

  return (
    <>
      <Button
        size="sm"
        disabled={disabled || enabledOptions.length === 0}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog className="w-full max-w-lg overflow-hidden p-0">
          <div className="border-b border-kumo-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-kumo-strong">Add reviewer</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-kumo-subtle">
              Create a retained conversation with an advisor that can inspect the code and run Plan Skills, but cannot edit the plan.
            </Dialog.Description>
          </div>
          <div className="p-4">
            <ModelEffortPicker options={options} value={selection} onChange={setSelection} />
          </div>
          <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!selected || selected.disabled}
              onClick={() => {
                if (!selected) return;
                onAdd({
                  kind: "tab",
                  provider: selected.provider,
                  model: selected.model,
                  effort: selection.effort,
                });
                setOpen(false);
              }}
            >
              Add reviewer
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}

export function buildReviewerModelOptions(providers: PlannerProviderMetadata[]): ReviewerModelOption[] {
  return buildOptions(providers).map((option) => {
    const provider = providers.find((candidate) => candidate.id === option.input.provider)!;
    const model = provider.models.find((candidate) => candidate.id === option.input.model)!;
    const { efforts, defaultEffort } = resolveModelEfforts(provider, model);
    return {
      value: option.value,
      label: model.displayName,
      description: provider.displayName,
      disabled: option.disabled,
      disabledReason: model.disabledReason || provider.disabledReasons[0],
      provider: provider.id,
      model: model.id,
      efforts: efforts.map((effort) => ({ value: effort.id, label: effort.displayName })),
      defaultEffort,
    };
  });
}

function resolveModelEfforts(
  provider: PlannerProviderMetadata,
  model: PlannerProviderMetadata["models"][number],
) {
  const efforts = model.efforts?.length ? model.efforts : provider.efforts;
  const preferredEffort = model.defaultEffort ?? provider.defaultEffort;
  return {
    efforts,
    defaultEffort: efforts.some((effort) => effort.id === preferredEffort)
      ? preferredEffort
      : efforts[0]?.id ?? provider.defaultEffort,
  };
}

export function buildOptions(
  providers: PlannerProviderMetadata[],
): Array<{
  value: string;
  label: string;
  disabled: boolean;
  input: AddReviewerAction;
}> {
  const options = [];
  for (const provider of providers) {
    if (!provider.capabilities.reviewer) continue;
    for (const model of provider.models) {
      const { defaultEffort } = resolveModelEfforts(provider, model);
      options.push({
        value: `tab|${provider.id}|${model.id}`,
        label: `${model.displayName} chat`,
        disabled: !provider.available || !model.available,
        input: {
          kind: "tab" as const,
          provider: provider.id,
          model: model.id,
          effort: defaultEffort,
        },
      });
    }
  }
  return options;
}
