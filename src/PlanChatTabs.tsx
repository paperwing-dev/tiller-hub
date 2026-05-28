import type { ReviewerRegistryEntry } from "../api/coordination/types";
import AddReviewerMenu from "./AddReviewerMenu";
import { PLAN_DEFAULT_MODEL, getPlanModelLabel } from "./plan-models";

interface PlanChatTabsProps {
  reviewers: ReviewerRegistryEntry[];
  activeTab: string;
  adding?: boolean;
  onActiveTabChange: (tab: string) => void;
  onResetWriter: () => void;
  onAddReviewer: (model: string) => void;
  onCloseReviewer: (threadId: string) => void;
}

export default function PlanChatTabs({
  reviewers,
  activeTab,
  adding = false,
  onActiveTabChange,
  onResetWriter,
  onAddReviewer,
  onCloseReviewer,
}: PlanChatTabsProps) {
  const tabLabels = getReviewerTabLabels(reviewers);
  const writerLabel = `Writer: ${getPlanModelLabel(PLAN_DEFAULT_MODEL)}`;

  return (
    <div className="flex items-center gap-1 border-b border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
      <div
        className={`flex items-center rounded text-xs font-medium ${
          activeTab === "writer"
            ? "bg-white text-[#24292f] shadow-sm"
            : "text-[#57606a] hover:bg-white"
        }`}
      >
        <button
          onClick={() => onActiveTabChange("writer")}
          className="px-2 py-1"
        >
          {writerLabel}
        </button>
        <button
          onClick={onResetWriter}
          className="px-1.5 py-1 text-[#8c959f] hover:text-red-600"
          title="Reset writer chat"
        >
          x
        </button>
      </div>
      {reviewers.map((reviewer) => (
        <div
          key={reviewer.threadId}
          className={`flex items-center rounded text-xs ${
            activeTab === reviewer.threadId
              ? "bg-white text-[#24292f] shadow-sm"
              : "text-[#57606a] hover:bg-white"
          }`}
        >
          <button
            onClick={() => onActiveTabChange(reviewer.threadId)}
            className="px-2 py-1"
          >
            {tabLabels.get(reviewer.threadId)}
          </button>
          <button
            onClick={() => onCloseReviewer(reviewer.threadId)}
            className="px-1.5 py-1 text-[#8c959f] hover:text-red-600"
            title="Close reviewer"
          >
            x
          </button>
        </div>
      ))}
      <AddReviewerMenu
        activeReviewerCount={reviewers.length}
        disabled={adding}
        onAdd={onAddReviewer}
      />
    </div>
  );
}

function getReviewerTabLabels(reviewers: ReviewerRegistryEntry[]): Map<string, string> {
  const totals = new Map<string, number>();
  for (const reviewer of reviewers) {
    totals.set(reviewer.reviewerModel, (totals.get(reviewer.reviewerModel) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const reviewer of reviewers) {
    const label = getPlanModelLabel(reviewer.reviewerModel);
    const total = totals.get(reviewer.reviewerModel) ?? 0;
    const index = (seen.get(reviewer.reviewerModel) ?? 0) + 1;
    seen.set(reviewer.reviewerModel, index);
    labels.set(reviewer.threadId, total > 1 ? `Rev: ${label} #${index}` : `Rev: ${label}`);
  }
  return labels;
}
