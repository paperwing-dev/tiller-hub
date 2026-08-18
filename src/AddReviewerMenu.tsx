import React, { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Popover } from "@cloudflare/kumo/components/popover";
import type { AgentSkillDefinition } from "../api/coordination/types";
import type { PlannerEffort, PlannerProviderMetadata } from "./api";
import ModelEffortPicker, { type ModelEffortOption } from "./ModelEffortPicker";

export type AddReviewerAction = {
  kind: "tab";
  provider: string;
  model: string;
  effort: PlannerEffort;
};

export interface ReviewerModelOption extends ModelEffortOption<PlannerEffort> {
  provider: string;
  model: string;
}

interface AddReviewerMenuProps {
  activeReviewerCount: number;
  providers: PlannerProviderMetadata[];
  disabled?: boolean;
  label?: string;
  compact?: boolean;
  iconOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAdd: (input: AddReviewerAction) => void;
  skills?: AgentSkillDefinition[];
  onInvokeSkill?: (skill: AgentSkillDefinition) => void;
}

export default function AddReviewerMenu({
  activeReviewerCount,
  providers,
  disabled = false,
  label = "Add reviewer",
  compact = false,
  iconOnly = false,
  open: controlledOpen,
  onOpenChange,
  onAdd,
  skills = [],
  onInvokeSkill,
}: AddReviewerMenuProps) {
  const options = useMemo(() => buildReviewerModelOptions(providers), [providers]);
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(open) : next;
    if (controlledOpen === undefined) setInternalOpen(resolved);
    onOpenChange?.(resolved);
  };
  const compactTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [selection, setSelection] = useState<{ model: string; effort: PlannerEffort }>(() => ({
    model: enabledOptions[0]?.value ?? "",
    effort: enabledOptions[0]?.defaultEffort ?? "high",
  }));

  useEffect(() => {
    if (enabledOptions.some((option) => option.value === selection.model)) return;
    const first = enabledOptions[0];
    if (first) setSelection({ model: first.value, effort: first.defaultEffort });
  }, [enabledOptions, selection.model]);

  const genericLimitReached = activeReviewerCount >= 4;
  const hasSkillLaunches = skills.length > 0 && Boolean(onInvokeSkill);

  const selected = options.find((option) => option.value === selection.model) ?? null;

  const addSelectedReviewer = () => {
    if (!selected || genericLimitReached) return;
    onAdd({
      kind: "tab",
      provider: selected.provider,
      model: selected.model,
      effort: selection.effort,
    });
    setOpen(false);
  };

  if (compact && iconOnly) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <button
          ref={compactTriggerRef}
          type="button"
          className="tiller-workspace-sidebar-action relative flex size-8 shrink-0 items-center justify-center text-kumo-default disabled:opacity-40"
          disabled={disabled || (enabledOptions.length === 0 && !hasSkillLaunches)}
          aria-label="Add reviewer"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <PlusIcon className="size-3.5 shrink-0" weight="bold" aria-hidden="true" />
        </button>
        <Popover.Content
          anchor={compactTriggerRef}
          side="left"
          align="start"
          sideOffset={6}
          positionMethod="fixed"
          className="tiller-add-reviewer-popover w-80 p-4"
        >
          <Popover.Title className="text-sm font-semibold text-kumo-strong">
            Add reviewer
          </Popover.Title>
          <Popover.Description className="mt-0.5 text-xs text-kumo-subtle">
            Start a reusable reviewer conversation or launch a saved skill.
          </Popover.Description>
          <ModelEffortPicker
            className="tiller-add-reviewer-picker mt-4"
            options={options}
            value={selection}
            onChange={setSelection}
          />
          {hasSkillLaunches && (
            <SkillLaunchList
              skills={skills}
              onInvoke={(skill) => {
                onInvokeSkill?.(skill);
                setOpen(false);
              }}
            />
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="flex h-10 items-center px-3 text-[13px] font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="tiller-add-reviewer-primary flex h-10 items-center px-4 text-[13px] font-semibold disabled:opacity-40"
              disabled={genericLimitReached || !selected || selected.disabled}
              onClick={addSelectedReviewer}
            >
              {genericLimitReached ? "Reviewer limit reached" : "Add reviewer"}
            </button>
          </div>
        </Popover.Content>
      </Popover>
    );
  }

  return (
    <>
      {compact ? (
        <button
          type="button"
          className={iconOnly
            ? "tiller-workspace-sidebar-action relative flex size-8 shrink-0 items-center justify-center text-kumo-default disabled:opacity-40"
            : "tiller-square-button tiller-square-button--secondary border-y-0 border-r-0 disabled:opacity-40"}
          disabled={disabled || (enabledOptions.length === 0 && !hasSkillLaunches)}
          aria-label="Add reviewer"
          onClick={() => setOpen(true)}
        >
          {iconOnly
            ? <PlusIcon className="size-3.5 shrink-0" weight="bold" aria-hidden="true" />
            : label}
        </button>
      ) : (
        <Button
          size="sm"
          className="text-[13px]"
          disabled={disabled || (enabledOptions.length === 0 && !hasSkillLaunches)}
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog className={`tiller-dialog-shell w-full max-w-lg overflow-hidden p-0 ${compact ? "tiller-reviewer-dialog" : ""}`}>
          <div className="tiller-dialog-header border-b border-kumo-line px-4 py-3">
            <Dialog.Title className="tiller-dialog-title text-sm font-semibold text-kumo-strong">Add reviewer</Dialog.Title>
            <Dialog.Description className="tiller-dialog-description mt-0.5 text-xs text-kumo-subtle">
              Start a reusable reviewer conversation or launch a saved skill.
            </Dialog.Description>
          </div>
          <div className="tiller-dialog-body p-4">
            <ModelEffortPicker
              options={options}
              value={selection}
              onChange={setSelection}
              effortControl={compact ? "status-bar" : "select"}
            />
            {hasSkillLaunches && (
              <SkillLaunchList
                skills={skills}
                onInvoke={(skill) => {
                  onInvokeSkill?.(skill);
                  setOpen(false);
                }}
              />
            )}
          </div>
          <div className="tiller-dialog-footer flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
            <Button className="tiller-dialog-button tiller-dialog-button--secondary text-[13px]" type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="tiller-dialog-button tiller-dialog-button--primary text-[13px]"
              disabled={genericLimitReached || !selected || selected.disabled}
              onClick={addSelectedReviewer}
            >
              {genericLimitReached ? "Reviewer limit reached" : "Add reviewer"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}

function SkillLaunchList({
  skills,
  onInvoke,
}: {
  skills: AgentSkillDefinition[];
  onInvoke: (skill: AgentSkillDefinition) => void;
}) {
  return (
    <div className="mt-4 border-t border-kumo-line pt-3">
      <div className="tiller-interface-label mb-1 text-[10px] font-medium text-kumo-default">
        Saved skills
      </div>
      <div className="grid gap-1">
        {skills.map((skill) => (
          <button
            key={skill.id}
            type="button"
            className="flex w-full items-start justify-between gap-3 px-2 py-2 text-left hover:bg-kumo-tint"
            onClick={() => onInvoke(skill)}
          >
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-kumo-default">
                {skill.label}
              </span>
              <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-kumo-subtle">
                {skill.description}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-kumo-subtle">
              {skill.agents.length} {skill.agents.length === 1 ? "agent" : "agents"}
            </span>
          </button>
        ))}
      </div>
    </div>
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
