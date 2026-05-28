import type { Artifact, PlanArtifact, PlanStatus } from "../api/coordination/types";
import { groupPlansByStatus, isPlanOutdatedForMain, renderArtifactBodyMarkdown } from "./plan-artifacts";

interface PlanCategorySidebarProps {
  artifacts: Artifact[];
  selectedPlanArtifactId: string | null;
  repoMainCommit: string | null;
  loading?: boolean;
  onSelect: (artifactId: string) => void;
  onNewPlan: () => void;
  onMove: (artifact: PlanArtifact, status: PlanStatus) => void;
  onDiscard: (artifact: PlanArtifact) => void;
}

const SECTIONS: Array<{ status: PlanStatus; label: string }> = [
  { status: "draft", label: "Draft" },
  { status: "todo", label: "Plans To Do" },
  { status: "completed", label: "Completed" },
  { status: "archived", label: "Archived" },
];

export default function PlanCategorySidebar({
  artifacts,
  selectedPlanArtifactId,
  repoMainCommit,
  loading = false,
  onSelect,
  onNewPlan,
  onMove,
  onDiscard,
}: PlanCategorySidebarProps) {
  const grouped = groupPlansByStatus(artifacts);

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-[#d0d7de] bg-[#fbfbfc]">
      <div className="flex items-center justify-between border-b border-[#d0d7de] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-[#24292f]">Plans</div>
          <div className="text-xs text-[#57606a]">Mutable Markdown plans</div>
        </div>
        <button
          onClick={onNewPlan}
          className="rounded bg-[#0969da] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#0860c4]"
        >
          New Plan
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && artifacts.length === 0 ? (
          <div className="px-4 py-6 text-sm text-[#57606a]">Loading plans...</div>
        ) : (
          SECTIONS.map((section) => (
            <section key={section.status} className="border-b border-[#eaeef2]">
              <div className="flex items-center justify-between px-4 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                  {section.label}
                </div>
                <div className="text-[11px] text-[#8c959f]">{grouped[section.status].length}</div>
              </div>
              {grouped[section.status].length === 0 ? (
                <div className="px-4 pb-3 text-xs text-[#8c959f]">Empty</div>
              ) : (
                grouped[section.status].map((plan) => (
                  <PlanRow
                    key={plan.id}
                    plan={plan}
                    selected={plan.id === selectedPlanArtifactId}
                    outdated={section.status === "todo" && isPlanOutdatedForMain(plan, repoMainCommit)}
                    onSelect={() => onSelect(plan.id)}
                    onMove={(status) => onMove(plan, status)}
                    onDiscard={() => onDiscard(plan)}
                  />
                ))
              )}
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

function PlanRow({
  plan,
  selected,
  outdated,
  onSelect,
  onMove,
  onDiscard,
}: {
  plan: PlanArtifact;
  selected: boolean;
  outdated: boolean;
  onSelect: () => void;
  onMove: (status: PlanStatus) => void;
  onDiscard: () => void;
}) {
  const markdown = renderArtifactBodyMarkdown(plan.body);
  const preview = markdown
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find(Boolean) ?? "No content yet";

  return (
    <div className={`border-t border-[#eef1f4] px-4 py-3 ${selected ? "bg-white" : ""}`}>
      <button onClick={onSelect} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-[#24292f]">
            {plan.title || "Untitled plan"}
          </span>
          {outdated && (
            <span className="shrink-0 rounded border border-[#d0d7de] bg-[#f6f8fa] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#57606a]">
              outdated
            </span>
          )}
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-[#57606a]">{preview}</div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[#8c959f]">
        <span>{formatTimestamp(plan.updatedAt)}</span>
        <div className="flex shrink-0 items-center gap-1">
          {(plan.status ?? "draft") === "draft" && (
            <button
              onClick={onDiscard}
              className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
            >
              Discard
            </button>
          )}
          <select
            value={plan.status ?? "draft"}
            onChange={(event) => onMove(event.target.value as PlanStatus)}
            className="rounded border border-[#d0d7de] bg-white px-1 py-0.5 text-[11px] text-[#57606a]"
          >
            {SECTIONS.map((section) => (
              <option key={section.status} value={section.status}>
                Move to {section.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}
