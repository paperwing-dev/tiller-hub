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
  reviewerTabStatuses?: ReadonlyMap<string, PlanTabStatus>;
  adding?: boolean;
  onActiveTabChange: (tab: string) => void;
  onOpenPlanSkills: () => void;
  onAddReviewer: (input: AddReviewerAction) => void;
  onCloseReviewer: (threadId: string) => void;
}

export default function PlanChatTabs({
  reviewers,
  providers,
  activeTab,
  writerTabStatus,
  reviewerTabStatuses = new Map(),
  adding = false,
  onActiveTabChange,
  onOpenPlanSkills,
  onAddReviewer,
  onCloseReviewer,
}: PlanChatTabsProps) {
  const tabLabels = getReviewerTabLabels(reviewers, providers);
  const writerLabel = "Plan Writer";
  const activeReviewer = reviewers.find((reviewer) => reviewer.threadId === activeTab) ?? null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-kumo-line bg-kumo-recessed px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex max-h-16 min-w-0 flex-1 flex-wrap items-center gap-1 overflow-y-auto pr-1">
          <AgentTabButton
            label={writerLabel}
            status={writerTabStatus}
            active={activeTab === "writer"}
            onClick={() => onActiveTabChange("writer")}
          />
          <span
            role="separator"
            aria-orientation="vertical"
            className="mx-1 h-5 w-px shrink-0 bg-kumo-line"
          />
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
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {activeReviewer && (
          <button
            type="button"
            onClick={() => onCloseReviewer(activeReviewer.threadId)}
            className="h-8 rounded border border-kumo-line bg-kumo-base px-2 text-xs font-medium text-kumo-subtle hover:bg-kumo-tint"
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
        <AddReviewerMenu
          activeReviewerCount={reviewers.length}
          providers={providers}
          disabled={adding}
          onAdd={onAddReviewer}
        />
      </div>
    </div>
  );
}

const READY_REVIEWER_STATUS: PlanTabStatus = {
  kind: "idle",
  label: "Ready",
  detail: "No review is in progress.",
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
