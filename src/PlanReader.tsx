import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import type { PlanArtifact } from "../api/coordination/types";
import MarkdownContent from "./MarkdownContent";
import { renderArtifactBodyMarkdown } from "./plan-artifacts";

interface PlanReaderProps {
  plan: PlanArtifact | null;
  saving?: boolean;
  mainUpdating?: boolean;
  onSave?: (markdown: string) => Promise<void>;
}

export default function PlanReader({
  plan,
  saving = false,
  mainUpdating = false,
  onSave,
}: PlanReaderProps) {
  const markdown = plan ? renderArtifactBodyMarkdown(plan.body) : "";
  const editable = isEditablePlan(plan);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
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
    setDraft(markdown);
    setEditing(false);
    setManualSaving(false);
    setSaveError(null);
  }, [markdown, plan]);

  useEffect(() => {
    if (editable || !editing) return;
    setDraft(markdown);
    setEditing(false);
    setSaveError(null);
  }, [editable, editing, markdown]);

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
    setDraft(markdown);
    setSaveError(null);
    setEditing(true);
  }, [markdown]);

  const cancelEditing = useCallback(() => {
    setDraft(markdown);
    setSaveError(null);
    setEditing(false);
  }, [markdown]);

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
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-kumo-subtle">
        Select or create a plan.
      </div>
    );
  }

  const displayVersion = getDisplayVersion(plan, markdown);
  const showSaving = saving || manualSaving;

  return (
    <div
      ref={scrollRef}
      onScroll={captureScroll}
      className={`min-h-0 flex-1 px-6 py-5 ${editing ? "flex flex-col overflow-hidden" : "overflow-y-auto"}`}
    >
      <div className="mb-4 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-kumo-strong">
            {plan.title || "Untitled plan"}
          </h1>
          <div className="mt-1 flex items-center gap-1 text-xs text-kumo-subtle">
            <span>v{displayVersion} · {formatTimestamp(plan.updatedAt)}</span>
            {mainUpdating && (
              <span role="status" aria-live="polite">· Main updating…</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showSaving && (
            <Badge variant="info" className="shrink-0">
              Saving plan...
            </Badge>
          )}
          {editable && onSave && (editing ? (
            <>
              <Button type="button" variant="secondary" size="sm" disabled={manualSaving} onClick={cancelEditing}>
                Cancel
              </Button>
              <Button type="button" variant="primary" size="sm" disabled={manualSaving} onClick={() => void persistDraft()}>
                Save
              </Button>
            </>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={beginEditing}>
              Edit
            </Button>
          ))}
        </div>
      </div>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <textarea
            aria-label="Plan Markdown"
            autoFocus
            disabled={manualSaving}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-0 flex-1 resize-none rounded border border-kumo-line bg-kumo-base p-3 font-mono text-sm leading-6 text-kumo-default outline-none focus:border-kumo-info focus:ring-2 focus:ring-kumo-info/20 disabled:opacity-60"
          />
          {saveError && (
            <p role="alert" className="shrink-0 text-xs text-kumo-danger">
              {saveError}
            </p>
          )}
        </div>
      ) : markdown.trim() ? (
        <article>
          <MarkdownContent>{markdown}</MarkdownContent>
        </article>
      ) : (
        <div className="rounded border border-dashed border-kumo-line bg-kumo-recessed px-4 py-6 text-sm text-kumo-subtle">
          This plan is empty.
        </div>
      )}
    </div>
  );
}

function isEditablePlan(plan: PlanArtifact | null): boolean {
  const status = plan?.status ?? "draft";
  return status === "draft" || status === "evaluating" || status === "todo";
}

function getDisplayVersion(plan: PlanArtifact, markdown: string): number {
  if (!markdown.trim()) return 0;
  return Math.max(1, (plan.version ?? 1) - 1);
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
