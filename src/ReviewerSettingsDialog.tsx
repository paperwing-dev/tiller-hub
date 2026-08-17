import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import type { ReviewerRegistryEntry } from "../api/coordination/types";
import type { PlannerEffort, PlannerProviderMetadata } from "./api";
import { buildReviewerModelOptions } from "./AddReviewerMenu";
import ModelEffortPicker, { type ModelEffortSelection } from "./ModelEffortPicker";

interface ReviewerSettingsDialogProps {
  reviewer: ReviewerRegistryEntry | null;
  providers: PlannerProviderMetadata[];
  open: boolean;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    threadId: string,
    input: { provider: string; model: string; effort: PlannerEffort },
  ) => Promise<void> | void;
}

export default function ReviewerSettingsDialog({
  reviewer,
  providers,
  open,
  disabled = false,
  onOpenChange,
  onSave,
}: ReviewerSettingsDialogProps) {
  const options = useMemo(() => buildReviewerModelOptions(providers), [providers]);
  const [selection, setSelection] = useState<ModelEffortSelection<PlannerEffort>>({
    model: "",
    effort: "high",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !reviewer) return;
    const option = options.find(
      (candidate) => candidate.provider === reviewer.provider && candidate.model === reviewer.model,
    );
    setSelection({
      model: option?.value ?? "",
      effort: reviewer.effort ?? option?.defaultEffort ?? "high",
    });
    setError(null);
  }, [open, options, reviewer]);

  const selected = options.find((option) => option.value === selection.model) ?? null;
  const unchanged = Boolean(
    reviewer
    && selected?.provider === reviewer.provider
    && selected.model === reviewer.model
    && selection.effort === (reviewer.effort ?? selected.defaultEffort),
  );

  const save = async () => {
    if (!reviewer || !selected || selected.disabled || saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(reviewer.threadId, {
        provider: selected.provider,
        model: selected.model,
        effort: selection.effort,
      });
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to update reviewer");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="tiller-dialog-shell tiller-reviewer-dialog w-full max-w-lg overflow-hidden p-0">
        <div className="tiller-dialog-header border-b border-kumo-line px-4 py-3">
          <Dialog.Title className="tiller-dialog-title text-sm font-semibold text-kumo-strong text-balance">
            Reviewer settings
          </Dialog.Title>
          <Dialog.Description className="tiller-dialog-description mt-0.5 text-xs leading-5 text-kumo-subtle text-pretty">
            Model and reasoning effort apply to the next review in this conversation. Existing responses stay attached.
          </Dialog.Description>
        </div>
        <div className="tiller-dialog-body p-4">
          <ModelEffortPicker
            options={options}
            value={selection}
            onChange={setSelection}
            disabled={disabled || saving}
            modelLabel="Model"
            effortLabel="Reasoning effort"
            effortControl="status-bar"
          />
          {disabled && (
            <p className="mt-4 text-[12px] leading-5 text-kumo-subtle">
              Stop the active reviewer before changing its model or reasoning effort.
            </p>
          )}
          {error && <p className="mt-4 text-[12px] leading-5 text-kumo-danger">{error}</p>}
        </div>
        <div className="tiller-dialog-footer flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="tiller-dialog-button tiller-dialog-button--secondary text-[13px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="tiller-dialog-button tiller-dialog-button--primary text-[13px]"
            disabled={!selected || selected.disabled || unchanged || disabled || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
