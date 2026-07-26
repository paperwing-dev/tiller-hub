import { CaretDownIcon, CaretRightIcon, FolderIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, PlanArtifact, PlanStatus } from "../api/coordination/types";
import { groupPlansByStatus, isPlanOutdatedForMain, renderArtifactBodyMarkdown } from "./plan-artifacts";
import LoadingIndicator from "./LoadingIndicator";

interface PlanCategorySidebarProps {
  artifacts: Artifact[];
  selectedPlanArtifactId: string | null;
  repoMainCommit: string | null;
  loading?: boolean;
  onSelect: (artifactId: string) => void;
  onMove: (artifact: PlanArtifact, status: PlanStatus) => void;
  onDiscard: (artifact: PlanArtifact) => void;
}

const SECTIONS: Array<{ status: PlanStatus; label: string }> = [
  { status: "draft", label: "Draft" },
  { status: "evaluating", label: "Evaluating" },
  { status: "todo", label: "To Do" },
  { status: "completed", label: "Done" },
  { status: "archived", label: "Archived" },
];

const DEFAULT_COLLAPSED: Record<PlanStatus, boolean> = {
  draft: false,
  evaluating: false,
  todo: false,
  completed: true,
  archived: true,
};

export default function PlanCategorySidebar({
  artifacts,
  selectedPlanArtifactId,
  repoMainCommit,
  loading = false,
  onSelect,
  onMove,
  onDiscard,
}: PlanCategorySidebarProps) {
  const grouped = groupPlansByStatus(artifacts);
  const selectedSectionStatus = useMemo(() => {
    if (!selectedPlanArtifactId) return null;
    for (const section of SECTIONS) {
      if (grouped[section.status].some((plan) => plan.id === selectedPlanArtifactId)) {
        return section.status;
      }
    }
    return null;
  }, [grouped, selectedPlanArtifactId]);
  const [collapsedSections, setCollapsedSections] = useState<Record<PlanStatus, boolean>>(
    () => DEFAULT_COLLAPSED,
  );

  useEffect(() => {
    if (!selectedSectionStatus) return;
    setCollapsedSections((current) => {
      if (!current[selectedSectionStatus]) return current;
      return { ...current, [selectedSectionStatus]: false };
    });
  }, [selectedSectionStatus]);

  const toggleSection = (status: PlanStatus) => {
    setCollapsedSections((current) => ({
      ...current,
      [status]: !current[status],
    }));
  };

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-kumo-line bg-kumo-recessed">
      <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-kumo-strong">Plans</div>
          <div className="text-xs text-kumo-subtle">Mutable Markdown plans</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && artifacts.length === 0 ? (
          <LoadingIndicator label="Loading plans" className="py-8" />
        ) : (
          SECTIONS.map((section) => {
            const plans = grouped[section.status];
            const collapsed = collapsedSections[section.status];
            return (
              <section key={section.status} className="border-b border-kumo-hairline">
                <button
                  type="button"
                  onClick={() => toggleSection(section.status)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-kumo-tint"
                >
                  {collapsed ? (
                    <CaretRightIcon className="h-3.5 w-3.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
                  ) : (
                    <CaretDownIcon className="h-3.5 w-3.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
                  )}
                  {collapsed ? (
                    <FolderIcon className="h-4 w-4 shrink-0 text-kumo-subtle" aria-hidden="true" />
                  ) : (
                    <FolderOpenIcon className="h-4 w-4 shrink-0 text-kumo-subtle" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle">
                    {section.label}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-kumo-subtle">
                    {plans.length}
                  </span>
                </button>
                {!collapsed && (
                  plans.length === 0 ? (
                    <div className="px-4 pb-3 pl-[4.25rem] text-xs text-kumo-subtle">Empty</div>
                  ) : (
                    plans.map((plan) => (
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
                  )
                )}
              </section>
            );
          })
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
    <div className={`border-t border-kumo-hairline px-4 py-3 ${selected ? "bg-kumo-base" : ""}`}>
      <button onClick={onSelect} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-kumo-default">
            {plan.title || "Untitled plan"}
          </span>
          {outdated && (
            <span className="shrink-0 rounded border border-kumo-line bg-kumo-recessed px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-kumo-subtle">
              outdated
            </span>
          )}
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-kumo-subtle">{preview}</div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-kumo-subtle">
        <span>{formatTimestamp(plan.updatedAt)}</span>
        <div className="flex shrink-0 items-center gap-1">
          {(plan.status ?? "draft") === "draft" && (
            <button
              onClick={onDiscard}
              className="rounded border border-kumo-danger/30 bg-kumo-base px-1.5 py-0.5 text-[11px] text-kumo-danger hover:bg-kumo-danger-tint"
            >
              Discard
            </button>
          )}
          <select
            value={plan.status ?? "draft"}
            onChange={(event) => onMove(event.target.value as PlanStatus)}
            className="rounded border border-kumo-line bg-kumo-base px-1 py-0.5 text-[11px] text-kumo-subtle"
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
