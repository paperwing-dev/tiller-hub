import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { CheckIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import type { PlanArtifact, PlanStatus } from "../api/coordination/types";
import MarkdownContent from "./MarkdownContent";
import { getPlanDisplayVersion, renderArtifactBodyMarkdown } from "./plan-artifacts";

interface PlanReaderProps {
  plan: PlanArtifact | null;
  saving?: boolean;
  showStatus?: boolean;
  blueprint?: boolean;
  actions?: ReactNode;
  onSave?: (markdown: string) => Promise<void>;
  onStatusChange?: (status: PlanStatus) => void;
  onDiscard?: () => void;
}

export default function PlanReader({
  plan,
  saving = false,
  showStatus = false,
  blueprint = false,
  actions,
  onSave,
  onStatusChange,
  onDiscard,
}: PlanReaderProps) {
  const markdown = plan ? renderArtifactBodyMarkdown(plan.body) : "";
  const displayMarkdown = blueprint && plan
    ? removeDuplicateLeadingPlanTitle(markdown, plan.title)
    : markdown;
  const editorMarkdown = plan ? buildEditorMarkdown(plan, markdown, blueprint) : markdown;
  const editable = isEditablePlan(plan);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(editorMarkdown);
  const [manualSaving, setManualSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const activePlanIdRef = useRef(plan?.id ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef({ planId: plan?.id ?? "", markdown });
  const snapshotRef = useRef<{ ratio: number; heading: string | null; headingOffset: number }>({
    ratio: 0,
    heading: null,
    headingOffset: 0,
  });

  useEffect(() => {
    const planId = plan?.id ?? "";
    if (activePlanIdRef.current === planId) return;
    activePlanIdRef.current = planId;
    setDraft(editorMarkdown);
    setEditing(false);
    setManualSaving(false);
    setSaveError(null);
  }, [editorMarkdown, plan]);

  useEffect(() => {
    if (editable || !editing) return;
    setDraft(editorMarkdown);
    setEditing(false);
    setSaveError(null);
  }, [editable, editing, editorMarkdown]);

  const captureScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
    const containerTop = node.getBoundingClientRect().top;
    const headings = Array.from(node.querySelectorAll<HTMLElement>("article h1, article h2, article h3, article h4, article h5, article h6"));
    const anchor = headings.filter((heading) => heading.getBoundingClientRect().top <= containerTop + 96).pop() ?? headings[0] ?? null;
    snapshotRef.current = {
      ratio: maximum > 0 ? node.scrollTop / maximum : 0,
      heading: anchor?.textContent?.trim() || null,
      headingOffset: anchor ? anchor.getBoundingClientRect().top - containerTop : 0,
    };
  }, []);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    const node = scrollRef.current;
    if (node && plan && previous.planId === plan.id && previous.markdown !== markdown) {
      const snapshot = snapshotRef.current;
      const matchingHeading = snapshot.heading
        ? Array.from(node.querySelectorAll<HTMLElement>("article h1, article h2, article h3, article h4, article h5, article h6"))
          .find((heading) => heading.textContent?.trim() === snapshot.heading)
        : null;
      if (matchingHeading) {
        const containerTop = node.getBoundingClientRect().top;
        node.scrollTop += matchingHeading.getBoundingClientRect().top - containerTop - snapshot.headingOffset;
      } else {
        node.scrollTop = snapshot.ratio * Math.max(0, node.scrollHeight - node.clientHeight);
      }
    }
    previousRef.current = { planId: plan?.id ?? "", markdown };
    captureScroll();
  }, [captureScroll, markdown, plan]);

  const beginEditing = useCallback(() => {
    setDraft(editorMarkdown);
    setSaveError(null);
    setEditing(true);
  }, [editorMarkdown]);

  const cancelEditing = useCallback(() => {
    setDraft(editorMarkdown);
    setSaveError(null);
    setEditing(false);
  }, [editorMarkdown]);

  const persistDraft = useCallback(async () => {
    if (!onSave || manualSaving) return;
    setManualSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save plan");
    } finally {
      setManualSaving(false);
    }
  }, [draft, manualSaving, onSave]);

  if (!plan) {
    if (blueprint) {
      return (
        <div className="tiller-plan-blueprint tiller-blueprint-empty-state flex min-h-0 flex-1 text-kumo-default">
          <div className="max-w-sm">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em]">No plan selected</p>
            <p className="mt-2 text-[13px] leading-5">Choose a plan from the index, or create a new one.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-kumo-subtle">
        Select or create a plan.
      </div>
    );
  }

  const displayVersion = getPlanDisplayVersion(plan);
  const showSaving = saving || manualSaving;

  if (editing) {
    return (
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${blueprint ? "tiller-plan-blueprint" : "bg-kumo-base"}`}>
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-recessed px-3">
          <span className="font-mono text-[11px] font-normal uppercase tracking-wide text-kumo-default">
            Markdown source
          </span>
          <div className="flex items-center gap-2">
            {showSaving && (
              <Badge variant="info" className="shrink-0">
                Saving plan...
              </Badge>
            )}
            <Button className="text-[13px]" type="button" variant="secondary" size="sm" disabled={manualSaving} onClick={cancelEditing}>
              Cancel
            </Button>
            <Button className="text-[13px]" type="button" variant="primary" size="sm" disabled={manualSaving} onClick={() => void persistDraft()}>
              Save
            </Button>
          </div>
        </div>
        <textarea
          aria-label="Plan Markdown"
          placeholder="# Untitled Plan"
          autoFocus
          spellCheck={false}
          disabled={manualSaving}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent p-4 font-mono text-base leading-6 text-kumo-default outline-none disabled:opacity-60"
        />
        {saveError && (
          <p role="alert" className="shrink-0 border-t border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-danger">
            {saveError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={captureScroll}
      className={`min-h-0 flex-1 ${blueprint ? "tiller-plan-blueprint tiller-plan-page pt-4 pb-3" : "px-6 py-5"} ${editing ? "flex flex-col overflow-hidden" : "overflow-y-auto"}`}
    >
      <div className={`shrink-0 ${blueprint
        ? "mb-4 grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_minmax(8rem,1fr)] items-start gap-x-3 gap-y-0"
        : "mb-4 flex items-start justify-between gap-3"}`}>
        {blueprint && (
          <div className="col-start-1 row-start-1 min-w-0">
            {showStatus && (
              <PlanStatusChecklist
                status={plan.status ?? "draft"}
                onChange={onStatusChange}
              />
            )}
          </div>
        )}
        <div className={`min-w-0 ${blueprint ? "col-start-2 row-start-2 mt-8 text-center" : ""}`}>
          <div className={`min-w-0 ${blueprint ? "" : "flex items-center gap-2"}`}>
            <h1 className={`font-semibold text-kumo-strong ${blueprint
              ? "tiller-plan-title truncate text-lg leading-tight"
              : "truncate text-lg"}`}>
              {plan.title || "Untitled plan"}
            </h1>
            {!blueprint && showStatus && (
              <PlanStatusChecklist
                status={plan.status ?? "draft"}
                onChange={onStatusChange}
              />
            )}
          </div>
          {blueprint ? (
            <div className="mt-1.5 whitespace-nowrap font-mono text-[11px] font-normal tabular-nums text-kumo-subtle">
              v{displayVersion} · Updated{" "}
              <time dateTime={plan.updatedAt} title={formatTimestamp(plan.updatedAt)}>
                {formatCompactTimestamp(plan.updatedAt)}
              </time>
            </div>
          ) : (
            <div className="mt-1 text-[11px] font-normal text-kumo-default">
              v{displayVersion} · {formatTimestamp(plan.updatedAt)}
            </div>
          )}
        </div>
        <div className={`min-w-0 shrink-0 text-right ${blueprint ? "col-start-3 row-start-1 -mt-3" : ""}`}>
          <div className="flex items-center justify-end gap-0">
            {showSaving && (
              <Badge variant="info" className="shrink-0">
                Saving plan...
              </Badge>
            )}
            {editable && onSave && (
              <Tooltip
                content="Edit markdown"
                side="top"
                delay={250}
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    shape="square"
                    size="sm"
                    aria-label="Edit markdown"
                    onClick={beginEditing}
                    className="tiller-plan-toolbar-button tiller-edit-markdown-button text-kumo-subtle hover:text-kumo-default"
                  />
                )}
              >
                <PencilSimpleIcon className="size-4" aria-hidden="true" />
                <span className="sr-only">Edit</span>
              </Tooltip>
            )}
            {onDiscard && (
              <Tooltip
                content={(plan.status ?? "draft") === "draft"
                  ? "Discard draft plan"
                  : "Only draft plans can be discarded"}
                side="top"
                delay={250}
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    shape="square"
                    size="sm"
                    aria-label={(plan.status ?? "draft") === "draft"
                      ? "Discard plan"
                      : "Discard plan (drafts only)"}
                    disabled={(plan.status ?? "draft") !== "draft"}
                    onClick={onDiscard}
                    className="tiller-plan-toolbar-button text-kumo-danger hover:text-kumo-danger disabled:cursor-not-allowed disabled:opacity-35"
                  />
                )}
              >
                <TrashIcon className="size-4" aria-hidden="true" />
                <span className="sr-only">Discard plan</span>
              </Tooltip>
            )}
            {actions}
          </div>
        </div>
      </div>

      {displayMarkdown.trim() ? (
        <article>
          <MarkdownContent className={blueprint ? "tiller-plan-document" : ""}>{displayMarkdown}</MarkdownContent>
        </article>
      ) : blueprint ? null : (
        <div className="rounded border border-dashed border-kumo-line bg-kumo-recessed px-4 py-6 text-sm text-kumo-subtle">
          This plan is empty.
        </div>
      )}
    </div>
  );
}

function removeDuplicateLeadingPlanTitle(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0 || lines[firstContentLine]?.trim() !== `# ${title.trim()}`) {
    return markdown;
  }

  let nextContentLine = firstContentLine + 1;
  while (nextContentLine < lines.length && !lines[nextContentLine]?.trim()) {
    nextContentLine += 1;
  }
  return [...lines.slice(0, firstContentLine), ...lines.slice(nextContentLine)].join("\n");
}

function buildEditorMarkdown(plan: PlanArtifact, markdown: string, blueprint: boolean): string {
  if (!blueprint) return markdown;
  if (!markdown.trim() && !plan.title.trim()) return "";
  const firstContentLine = markdown
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstContentLine?.startsWith("# ")) return markdown;
  const title = plan.title.trim() || "Untitled plan";
  return markdown ? `# ${title}\n\n${markdown}` : `# ${title}\n\n`;
}

function isEditablePlan(plan: PlanArtifact | null): boolean {
  const status = plan?.status ?? "draft";
  return status === "draft" || status === "evaluating" || status === "todo";
}

const PLAN_STATUS_OPTIONS: Array<{ status: PlanStatus; label: string }> = [
  { status: "draft", label: "Draft" },
  { status: "evaluating", label: "Review" },
  { status: "todo", label: "Ready" },
  { status: "completed", label: "Done" },
  { status: "archived", label: "Archived" },
];

function PlanStatusChecklist({
  status,
  onChange,
}: {
  status: PlanStatus;
  onChange?: (status: PlanStatus) => void;
}) {
  const statusGroupName = useId();
  return (
    <fieldset aria-label="Plan status" className="grid w-fit grid-cols-2 gap-x-3 gap-y-1">
      <legend className="sr-only">Plan status</legend>
      {PLAN_STATUS_OPTIONS.map((option) => (
        <label
          key={option.status}
          className="inline-flex cursor-pointer items-start gap-1.5 text-xs font-normal text-kumo-default"
        >
          <input
            type="radio"
            name={statusGroupName}
            aria-label={`Plan status: ${option.label}`}
            checked={status === option.status}
            readOnly={!onChange}
            onChange={() => onChange?.(option.status)}
            className="peer sr-only"
          />
          <span
            data-plan-status-indicator
            aria-hidden="true"
            className="mt-px flex size-3 shrink-0 items-center justify-center border border-kumo-line bg-transparent peer-checked:border-[var(--tiller-theme-action)] peer-checked:bg-[var(--tiller-theme-action)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-kumo-focus"
          >
            {status === option.status && (
              <CheckIcon className="tiller-plan-status-check size-2.5" weight="bold" />
            )}
          </span>
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatCompactTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart}, ${timePart}`;
}
