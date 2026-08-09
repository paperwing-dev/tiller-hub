import React from "react";
import type { ReviewerRegistryEntry } from "../api/coordination/types";
import AddReviewerMenu, { type AddReviewerAction } from "./AddReviewerMenu";
import type { PlannerProviderMetadata } from "./api";
import AgentTabButton from "./AgentTabButton";
import type { PlanTabStatus } from "./plan-tab-status";

interface PlanChatTabsProps {
  reviewers: ReviewerRegistryEntry[];
  providers: PlannerProviderMetadata[];
  activeTab: string;
  writerTabStatus: PlanTabStatus;
  pendingScribeCount?: number;
  reviewerTabStatuses?: ReadonlyMap<string, PlanTabStatus>;
  adding?: boolean;
  reviewerDialogOpen?: boolean;
  onActiveTabChange: (tab: string) => void;
  onReviewerDialogOpenChange?: (open: boolean) => void;
  onOpenPlanSkills: () => void;
  onAddReviewer: (input: AddReviewerAction) => void;
  onCloseReviewer: (threadId: string) => void;
}

export default function PlanChatTabs({
  reviewers,
  providers,
  activeTab,
  writerTabStatus,
  pendingScribeCount = 0,
  reviewerTabStatuses = new Map(),
  adding = false,
  reviewerDialogOpen,
  onActiveTabChange,
  onReviewerDialogOpenChange,
  onOpenPlanSkills,
  onAddReviewer,
  onCloseReviewer,
}: PlanChatTabsProps) {
  const tabLabels = getReviewerTabLabels(reviewers, providers);
  const writerLabel = "Scribe";
  const activeReviewer = reviewers.find((reviewer) => reviewer.threadId === activeTab) ?? null;

  return (
    <div className="flex items-end justify-between gap-3 border-b border-kumo-line bg-kumo-recessed px-3 py-2">
      <div className="flex min-w-0 flex-1 items-stretch gap-3" aria-label="Plan collaborators">
        <div role="group" aria-label="Edits the plan" className="flex shrink-0 flex-col justify-end gap-0.5">
          <span className="px-2 text-[9px] font-semibold uppercase tracking-wide text-kumo-subtle">
            Edits the plan
          </span>
          <AgentTabButton
            label={writerLabel}
            status={writerTabStatus}
            active={activeTab === "writer"}
            badge={pendingScribeCount}
            onClick={() => onActiveTabChange("writer")}
          />
        </div>
        <span
          role="separator"
          aria-orientation="vertical"
          className="h-10 w-px shrink-0 self-end bg-kumo-line"
        />
        <div role="group" aria-label="Advises on the plan" className="flex min-w-0 flex-1 flex-col justify-end gap-0.5">
          <span className="px-2 text-[9px] font-semibold uppercase tracking-wide text-kumo-subtle">
            Advises on the plan
          </span>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto pr-1">
            {reviewers.map((reviewer) => {
              const label = tabLabels.get(reviewer.threadId) ?? "Reviewer";
              const status = reviewerTabStatuses.get(reviewer.threadId) ?? READY_REVIEWER_STATUS;
              return (
                <AgentTabButton
                  key={reviewer.threadId}
                  label={label}
                  status={status}
                  active={activeTab === reviewer.threadId}
                  onClick={() => onActiveTabChange(reviewer.threadId)}
                />
              );
            })}
            <AddReviewerMenu
              activeReviewerCount={reviewers.length}
              providers={providers}
              disabled={adding}
              label="+ Reviewer"
              open={reviewerDialogOpen}
              onOpenChange={onReviewerDialogOpenChange}
              onAdd={onAddReviewer}
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {activeReviewer && (
          <button
            type="button"
            onClick={() => onCloseReviewer(activeReviewer.threadId)}
            className="h-8 rounded border border-kumo-danger/30 bg-kumo-base px-2 text-xs font-medium text-kumo-danger transition-colors hover:border-kumo-danger/50 hover:bg-kumo-danger-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
          >
            Remove reviewer
          </button>
        )}
        <button
          type="button"
          onClick={onOpenPlanSkills}
          className="h-8 rounded border border-kumo-line bg-kumo-base px-2 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
        >
          Plan Skills
        </button>
      </div>
    </div>
  );
}

const READY_REVIEWER_STATUS: PlanTabStatus = {
  kind: "idle",
  label: "Ready",
  detail: "Ready for your next question.",
};

// Reviewer tabs are labeled by the model's display name ("GPT 5.5"), numbered
// only when the same model is added more than once.
function getReviewerTabLabels(
  reviewers: ReviewerRegistryEntry[],
  providers: PlannerProviderMetadata[],
): Map<string, string> {
  const displayNames = new Map<string, string>();
  for (const provider of providers) {
    for (const model of provider.models) {
      displayNames.set(`${provider.id}|${model.id}`, model.displayName);
    }
  }
  const displayName = (reviewer: ReviewerRegistryEntry) =>
    displayNames.get(`${reviewer.provider}|${reviewer.model}`) ?? reviewer.model;

  const totals = new Map<string, number>();
  for (const reviewer of reviewers) {
    const key = displayName(reviewer);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const reviewer of reviewers) {
    const key = displayName(reviewer);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    labels.set(reviewer.threadId, (totals.get(key) ?? 0) > 1 ? `${key} #${index}` : key);
  }
  return labels;
}
