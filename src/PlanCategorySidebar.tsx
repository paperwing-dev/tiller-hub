import {
  ClockCounterClockwiseIcon,
  PlusIcon,
  RocketLaunchIcon,
  RulerIcon,
  ShieldWarningIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type {
  Artifact,
  PlanArtifact,
  PlanHealthAssessment,
  PlanStatus,
} from "../api/coordination/types";
import {
  getPlanDisplayVersion,
  groupPlansByStatus,
  isPlanOutdatedForMain,
  renderArtifactBodyMarkdown,
} from "./plan-artifacts";
import LoadingIndicator from "./LoadingIndicator";
import WorkspaceMetadata from "./WorkspaceMetadata";

interface PlanCategorySidebarProps {
  artifacts: Artifact[];
  selectedPlanArtifactId: string | null;
  repoMainCommit: string | null;
  loading?: boolean;
  attentionPlanIds?: ReadonlySet<string>;
  simplified?: boolean;
  resizable?: boolean;
  width?: number;
  creatingPlan?: boolean;
  reviewerWarningCounts?: Readonly<Record<string, number>>;
  reviewerUpdateCounts?: Readonly<Record<string, number>>;
  onCreatePlan?: () => void;
  onPrefetch?: (artifactId: string) => void;
  onStartImplementation?: (artifact: PlanArtifact, configure: boolean) => void;
  onSelect: (artifactId: string) => void;
  onMove: (artifact: PlanArtifact, status: PlanStatus) => void;
  onDiscard: (artifact: PlanArtifact) => void;
}

type PlanSectionKey =
  "draft" | "review" | "ready" | "done" | "archived" | "history";

interface PlanSection {
  key: PlanSectionKey;
  label: string;
  statuses: PlanStatus[];
  dropStatus: PlanStatus;
}

const FULL_SECTIONS: PlanSection[] = [
  { key: "draft", label: "Draft", statuses: ["draft"], dropStatus: "draft" },
  {
    key: "review",
    label: "Evaluating",
    statuses: ["evaluating"],
    dropStatus: "evaluating",
  },
  {
    key: "ready",
    label: "Ready to build",
    statuses: ["todo"],
    dropStatus: "todo",
  },
  {
    key: "done",
    label: "Done",
    statuses: ["completed"],
    dropStatus: "completed",
  },
  {
    key: "archived",
    label: "Archived",
    statuses: ["archived"],
    dropStatus: "archived",
  },
];

const SIMPLIFIED_SECTIONS: PlanSection[] = [
  { key: "draft", label: "In Draft", statuses: ["draft"], dropStatus: "draft" },
  {
    key: "review",
    label: "In Review",
    statuses: ["evaluating"],
    dropStatus: "evaluating",
  },
  { key: "ready", label: "Ready", statuses: ["todo"], dropStatus: "todo" },
  {
    key: "done",
    label: "Done",
    statuses: ["completed"],
    dropStatus: "completed",
  },
  {
    key: "history",
    label: "Archived",
    statuses: ["archived"],
    dropStatus: "archived",
  },
];

interface PlanContextMenuState {
  plan: PlanArtifact;
  x: number;
  y: number;
}

interface PlanHoverCardState {
  title: string;
  updatedAt?: string;
  planHealth?: PlanHealthAssessment;
  version: number;
  top: number;
  left: number;
}

const DEFAULT_COLLAPSED: Record<PlanSectionKey, boolean> = {
  draft: false,
  review: false,
  ready: false,
  done: true,
  archived: true,
  history: true,
};

export default function PlanCategorySidebar({
  artifacts,
  selectedPlanArtifactId,
  repoMainCommit,
  loading = false,
  attentionPlanIds = new Set(),
  simplified = false,
  resizable = false,
  width,
  creatingPlan = false,
  reviewerWarningCounts = {},
  reviewerUpdateCounts = {},
  onCreatePlan,
  onPrefetch,
  onStartImplementation,
  onSelect,
  onMove,
  onDiscard,
}: PlanCategorySidebarProps) {
  const grouped = groupPlansByStatus(artifacts);
  const sections = simplified ? SIMPLIFIED_SECTIONS : FULL_SECTIONS;
  const selectedSectionStatus = useMemo(() => {
    if (!selectedPlanArtifactId) return null;
    for (const section of sections) {
      if (
        section.statuses.some((status) =>
          grouped[status].some((plan) => plan.id === selectedPlanArtifactId),
        )
      ) {
        return section.key;
      }
    }
    return null;
  }, [grouped, sections, selectedPlanArtifactId]);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<PlanSectionKey, boolean>
  >(() => DEFAULT_COLLAPSED);
  const [dragOverSection, setDragOverSection] = useState<PlanSectionKey | null>(
    null,
  );
  const [contextMenu, setContextMenu] = useState<PlanContextMenuState | null>(
    null,
  );
  const [hoverCard, setHoverCard] = useState<PlanHoverCardState | null>(null);
  const planButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const sidebarPlans = sections.flatMap((section) =>
    section.statuses.flatMap((status) => grouped[status]),
  );
  const sidebarReviewerWarningCount = sidebarPlans.reduce(
    (count, plan) => count + (reviewerWarningCounts[plan.id] ?? 0),
    0,
  );
  const sidebarReviewerUpdateCount = sidebarPlans.reduce(
    (count, plan) =>
      count + planUpdateCount(plan, reviewerUpdateCounts, attentionPlanIds),
    0,
  );

  useEffect(() => {
    if (!selectedSectionStatus) return;
    setCollapsedSections((current) => {
      if (!current[selectedSectionStatus]) return current;
      return { ...current, [selectedSectionStatus]: false };
    });
  }, [selectedSectionStatus]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeForPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-plan-context-menu]")
      )
        return;
      setContextMenu(null);
    };
    const closeForKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const closeForBlur = () => setContextMenu(null);
    window.addEventListener("pointerdown", closeForPointer);
    window.addEventListener("keydown", closeForKey);
    window.addEventListener("blur", closeForBlur);
    return () => {
      window.removeEventListener("pointerdown", closeForPointer);
      window.removeEventListener("keydown", closeForKey);
      window.removeEventListener("blur", closeForBlur);
    };
  }, [contextMenu]);

  const openPlanContextMenu = (event: ReactMouseEvent, plan: PlanArtifact) => {
    if (!simplified || !onStartImplementation) return;
    event.preventDefault();
    setHoverCard(null);
    onPrefetch?.(plan.id);
    const menuWidth = 216;
    const menuHeight = 78;
    setContextMenu({
      plan,
      x: Math.max(
        8,
        Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      ),
      y: Math.max(
        8,
        Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      ),
    });
  };

  const showPlanHoverCard = (
    plan: PlanArtifact,
    element: HTMLButtonElement,
  ) => {
    if (!simplified) return;
    const rect = element.getBoundingClientRect();
    const cardWidth = 288;
    const cardHeight = 136;
    const preferredLeft = rect.right + 8;
    const left =
      preferredLeft + cardWidth <= window.innerWidth - 16
        ? preferredLeft
        : Math.max(16, rect.left - cardWidth - 8);
    const top = Math.max(
      16,
      Math.min(rect.top - 4, window.innerHeight - cardHeight - 16),
    );
    setHoverCard({
      title: plan.title || "Untitled plan",
      updatedAt: plan.updatedAt,
      ...(plan.planHealth ? { planHealth: plan.planHealth } : {}),
      version: getPlanDisplayVersion(plan),
      top,
      left,
    });
  };

  const toggleSection = (key: PlanSectionKey) => {
    setCollapsedSections((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const visiblePlanIds = sections.flatMap((section) => {
    if (collapsedSections[section.key]) return [];
    return section.statuses
      .flatMap((status) => grouped[status])
      .sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
      )
      .map((plan) => plan.id);
  });

  const navigatePlanList = (
    event: KeyboardEvent<HTMLButtonElement>,
    artifactId: string,
  ) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const currentIndex = visiblePlanIds.indexOf(artifactId);
    if (currentIndex < 0 || visiblePlanIds.length === 0) return;
    const targetIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visiblePlanIds.length - 1
          : event.key === "ArrowDown"
            ? Math.min(visiblePlanIds.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
    const targetId = visiblePlanIds[targetIndex];
    if (!targetId || targetId === artifactId) return;
    event.preventDefault();
    onPrefetch?.(targetId);
    onSelect(targetId);
    requestAnimationFrame(() => planButtonRefs.current.get(targetId)?.focus());
  };

  return (
    <aside
      data-testid={simplified ? "plans-sidebar" : undefined}
      className={`tiller-workspace-sidebar flex shrink-0 flex-col bg-kumo-recessed ${
        simplified
          ? `w-[320px] ${resizable ? "" : "border-r border-kumo-line"}`
          : "w-[280px] border-l border-kumo-line"
      }`}
      style={width === undefined ? undefined : { width }}
    >
      {simplified ? (
        <div className="tiller-hover-count-metadata tiller-workspace-sidebar-header flex h-11 shrink-0 items-center border-b border-kumo-line">
          <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
            <span className="min-w-0 truncate text-[13px] font-semibold text-kumo-default">
              Plans
            </span>
            <WorkspaceMetadata
              count={sidebarPlans.length}
              warning={{
                count: sidebarReviewerWarningCount,
                label: `${sidebarReviewerWarningCount} plan ${sidebarReviewerWarningCount === 1 ? "issue" : "issues"}`,
              }}
              update={{
                count: sidebarReviewerUpdateCount,
                label: `${sidebarReviewerUpdateCount} new plan ${sidebarReviewerUpdateCount === 1 ? "update" : "updates"}`,
              }}
              className="tiller-workspace-sidebar-meta text-kumo-default"
            />
          </div>
          {onCreatePlan && (
            <Tooltip
              content={creatingPlan ? "Creating plan" : "Create plan"}
              side="bottom"
              align="end"
              delay={250}
              render={
                <button
                  type="button"
                  disabled={creatingPlan}
                  onClick={onCreatePlan}
                  aria-label={creatingPlan ? "Creating plan" : "Create plan"}
                  className="tiller-workspace-sidebar-action relative mr-3 flex size-8 shrink-0 items-center justify-center text-kumo-default disabled:opacity-50"
                />
              }
            >
              <PlusIcon
                className="size-3.5 shrink-0"
                weight="bold"
                aria-hidden="true"
              />
            </Tooltip>
          )}
        </div>
      ) : (
        <div className="tiller-workspace-sidebar-header flex items-center justify-between border-b border-kumo-line px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <div className="text-[13px] font-semibold text-kumo-strong">
              Plans
            </div>
            <div className="text-xs text-kumo-subtle">
              Specifications for upcoming work
            </div>
          </div>
        </div>
      )}

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${simplified ? "py-1" : ""}`}
      >
        {loading && artifacts.length === 0 ? (
          <LoadingIndicator label="Loading plans" className="py-8" />
        ) : (
          sections.map((section, sectionIndex) => {
            const plans = section.statuses
              .flatMap((status) => grouped[status])
              .sort((left, right) =>
                (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
              );
            const reviewerUpdateCount = plans.reduce(
              (count, plan) =>
                count +
                planUpdateCount(plan, reviewerUpdateCounts, attentionPlanIds),
              0,
            );
            const reviewerWarningCount = plans.reduce(
              (count, plan) => count + (reviewerWarningCounts[plan.id] ?? 0),
              0,
            );
            const collapsed = collapsedSections[section.key];
            return (
              <section
                key={`${section.key}:${sectionIndex}`}
                className={`${simplified ? "tiller-workspace-sidebar-section" : "border-b border-kumo-hairline"} ${
                  simplified && dragOverSection === section.key
                    ? "bg-kumo-tint"
                    : ""
                }`}
                onDragOver={
                  simplified
                    ? (event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDragOverSection(section.key);
                      }
                    : undefined
                }
                onDragLeave={
                  simplified
                    ? (event) => {
                        if (
                          event.currentTarget.contains(
                            event.relatedTarget as Node | null,
                          )
                        )
                          return;
                        setDragOverSection((current) =>
                          current === section.key ? null : current,
                        );
                      }
                    : undefined
                }
                onDrop={
                  simplified
                    ? (event) => {
                        event.preventDefault();
                        const planId = event.dataTransfer.getData("text/plain");
                        const draggedPlan = Object.values(grouped)
                          .flat()
                          .find((plan) => plan.id === planId);
                        setDragOverSection(null);
                        if (
                          !draggedPlan ||
                          (draggedPlan.status ?? "draft") === section.dropStatus
                        )
                          return;
                        setCollapsedSections((current) => ({
                          ...current,
                          [section.key]: false,
                        }));
                        onMove(draggedPlan, section.dropStatus);
                      }
                    : undefined
                }
              >
                <div
                  className={
                    simplified
                      ? "relative flex min-w-0 items-center"
                      : "contents"
                  }
                >
                  <button
                    type="button"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={!collapsed}
                    data-plan-section-toggle={section.key}
                    className={`relative flex min-w-0 items-center gap-2 text-left hover:bg-kumo-tint ${simplified ? "tiller-hover-count-metadata tiller-workspace-sidebar-section-toggle h-8 w-full px-3" : "w-full px-4 py-2 transition-colors"}`}
                  >
                    <span
                      className="tiller-workspace-sidebar-section-caret flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle"
                      data-collapsed={collapsed ? "true" : "false"}
                      aria-hidden="true"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate ${simplified ? "text-[12px] font-medium text-kumo-default" : "text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle"}`}
                    >
                      {section.label}
                    </span>
                    {!simplified &&
                      section.statuses.every(
                        (status) =>
                          status !== "completed" && status !== "archived",
                      ) &&
                      plans.some((plan) => attentionPlanIds.has(plan.id)) && (
                        <span className="sr-only">Needs attention</span>
                      )}
                    <WorkspaceMetadata
                      count={plans.length}
                      warning={
                        simplified
                          ? {
                              count: reviewerWarningCount,
                              label: `${reviewerWarningCount} plan ${reviewerWarningCount === 1 ? "issue" : "issues"}`,
                            }
                          : undefined
                      }
                      update={
                        simplified
                          ? {
                              count: reviewerUpdateCount,
                              label: `${reviewerUpdateCount} new plan ${reviewerUpdateCount === 1 ? "update" : "updates"}`,
                            }
                          : undefined
                      }
                      className="tiller-workspace-sidebar-meta text-kumo-default"
                    />
                  </button>
                </div>
                {!collapsed &&
                  (plans.length === 0 ? (
                    simplified ? null : (
                      <div className="px-4 pb-3 pl-[4.25rem] text-xs text-kumo-subtle">
                        Empty
                      </div>
                    )
                  ) : (
                    plans.map((plan, planIndex) => (
                      <PlanRow
                        key={plan.id}
                        plan={plan}
                        lastInSection={planIndex === plans.length - 1}
                        selected={plan.id === selectedPlanArtifactId}
                        outdated={
                          (plan.status ?? "draft") === "todo" &&
                          isPlanOutdatedForMain(plan, repoMainCommit)
                        }
                        simplified={simplified}
                        reviewerWarningCount={
                          reviewerWarningCounts[plan.id] ?? 0
                        }
                        reviewerUpdateCount={planUpdateCount(
                          plan,
                          reviewerUpdateCounts,
                          attentionPlanIds,
                        )}
                        onMouseEnter={(element) => {
                          onPrefetch?.(plan.id);
                          showPlanHoverCard(plan, element);
                        }}
                        onMouseLeave={() => setHoverCard(null)}
                        onFocus={(element) => {
                          onPrefetch?.(plan.id);
                          showPlanHoverCard(plan, element);
                        }}
                        onBlur={() => setHoverCard(null)}
                        onSelect={() => {
                          setHoverCard(null);
                          onSelect(plan.id);
                        }}
                        onContextMenu={(event) =>
                          openPlanContextMenu(event, plan)
                        }
                        onKeyDown={(event) => navigatePlanList(event, plan.id)}
                        registerButton={(node) => {
                          if (node) planButtonRefs.current.set(plan.id, node);
                          else planButtonRefs.current.delete(plan.id);
                        }}
                        onMove={(status) => onMove(plan, status)}
                        onDiscard={() => onDiscard(plan)}
                        onDragEnd={() => setDragOverSection(null)}
                      />
                    ))
                  ))}
              </section>
            );
          })
        )}
      </div>
      {contextMenu &&
        onStartImplementation &&
        createPortal(
          <PlanContextMenu
            state={contextMenu}
            onStart={(configure) => {
              const contextPlan = contextMenu.plan;
              setContextMenu(null);
              onStartImplementation(contextPlan, configure);
            }}
          />,
          document.body,
        )}
      {hoverCard && <PlanHoverCard card={hoverCard} />}
    </aside>
  );
}

function PlanRow({
  plan,
  lastInSection,
  selected,
  outdated,
  simplified,
  reviewerWarningCount,
  reviewerUpdateCount,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onSelect,
  onContextMenu,
  onKeyDown,
  registerButton,
  onMove,
  onDiscard,
  onDragEnd,
}: {
  plan: PlanArtifact;
  lastInSection: boolean;
  selected: boolean;
  outdated: boolean;
  simplified: boolean;
  reviewerWarningCount: number;
  reviewerUpdateCount: number;
  onMouseEnter: (element: HTMLButtonElement) => void;
  onMouseLeave: () => void;
  onFocus: (element: HTMLButtonElement) => void;
  onBlur: () => void;
  onSelect: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  registerButton: (node: HTMLButtonElement | null) => void;
  onMove: (status: PlanStatus) => void;
  onDiscard: () => void;
  onDragEnd: () => void;
}) {
  const descriptionId = `plan-hover-description-${plan.id}`;
  const markdown = renderArtifactBodyMarkdown(plan.body);
  const preview =
    markdown
      .split("\n")
      .map((line) => line.trim().replace(/^#+\s*/, ""))
      .find((line) => Boolean(line) && line !== plan.title.trim()) ??
    "No content yet";
  const currentStatus = plan.status ?? "draft";
  const risk = planRiskLabel(plan.planHealth);
  const changeSize = planChangeSizeLabel(plan.planHealth);
  const displayVersion = getPlanDisplayVersion(plan);
  const displayedStatus =
    simplified && currentStatus === "archived" ? "completed" : currentStatus;
  const statusOptions: Array<{ status: PlanStatus; label: string }> = simplified
    ? [
        { status: "draft", label: "Draft" },
        { status: "evaluating", label: "Review" },
        { status: "todo", label: "Ready" },
        { status: "completed", label: "History" },
      ]
    : [
        { status: "draft", label: "Draft" },
        { status: "evaluating", label: "Evaluating" },
        { status: "todo", label: "Ready to build" },
        { status: "completed", label: "Done" },
        { status: "archived", label: "Archived" },
      ];

  if (simplified) {
    return (
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", plan.id);
        }}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu}
        className={`tiller-plan-index-row group relative h-10 pl-10 pr-3 ${selected ? "tiller-plan-index-row-selected" : ""}`}
      >
        <span
          className="tiller-plan-tree-connector absolute inset-y-0 left-[18px] w-3.5"
          data-last-child={lastInSection ? "true" : "false"}
          aria-hidden="true"
        />
        <button
          ref={registerButton}
          type="button"
          onClick={onSelect}
          onMouseEnter={(event) => onMouseEnter(event.currentTarget)}
          onMouseLeave={onMouseLeave}
          onFocus={(event) => onFocus(event.currentTarget)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          aria-current={selected ? "page" : undefined}
          aria-describedby={descriptionId}
          data-plan-row-title={plan.title || "Untitled plan"}
          className="flex h-full w-full min-w-0 items-center justify-between gap-2 text-left"
        >
          <span className="min-w-0 truncate text-[13px] font-medium text-kumo-default">
            {plan.title || "Untitled plan"}
          </span>
          <WorkspaceMetadata
            warning={{
              count: reviewerWarningCount,
              label: `${reviewerWarningCount} plan ${reviewerWarningCount === 1 ? "issue" : "issues"}`,
            }}
            update={{
              count: reviewerUpdateCount,
              label: `${reviewerUpdateCount} new plan ${reviewerUpdateCount === 1 ? "update" : "updates"}`,
            }}
            className="tiller-workspace-sidebar-meta text-kumo-default"
          />
          <span id={descriptionId} className="sr-only">
            Updated {formatPlanDate(plan.updatedAt)}. Risk {risk}. Change size{" "}
            {changeSize}. Version {displayVersion}.
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`border-t border-kumo-hairline px-4 py-3 ${selected ? "bg-kumo-base" : ""}`}
    >
      <button onClick={onSelect} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-kumo-default">
            {plan.title || "Untitled plan"}
          </span>
          {reviewerWarningCount > 0 && (
            <span className="sr-only">Needs attention</span>
          )}
          {outdated && (
            <span className="shrink-0 rounded border border-kumo-line bg-kumo-recessed px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-kumo-subtle">
              project changed
            </span>
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-kumo-subtle">
          {preview}
        </div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-kumo-subtle">
        <span>{formatTimestamp(plan.updatedAt)}</span>
        <div className="flex shrink-0 items-center gap-1">
          {(plan.status ?? "draft") === "draft" && (
            <button
              onClick={onDiscard}
              className="rounded border border-kumo-danger/30 bg-kumo-base px-1.5 py-0.5 text-[10px] text-kumo-danger hover:bg-kumo-danger-tint"
            >
              Discard
            </button>
          )}
          <select
            value={displayedStatus}
            onChange={(event) => onMove(event.target.value as PlanStatus)}
            className="rounded border border-kumo-line bg-kumo-base px-1 py-0.5 text-[11px] text-kumo-subtle"
          >
            {statusOptions.map((option) => (
              <option key={option.status} value={option.status}>
                Move to {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function PlanHoverCard({ card }: { card: PlanHoverCardState }) {
  const risk = planRiskLabel(card.planHealth);
  const changeSize = planChangeSizeLabel(card.planHealth);
  return (
    <div
      role="tooltip"
      data-testid="plan-hover-card"
      className="tiller-card-surface tiller-floating-surface pointer-events-none fixed z-50 w-[18rem] border border-kumo-line bg-kumo-recessed px-4 py-3 text-kumo-default"
      style={{ top: card.top, left: card.left }}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-4">
        <span className="truncate text-[13px] font-semibold">{card.title}</span>
        <time
          dateTime={card.updatedAt}
          className="shrink-0 font-mono text-[11px] font-normal tabular-nums text-kumo-subtle"
        >
          {formatPlanDate(card.updatedAt)}
        </time>
      </div>
      <div className="mt-3 space-y-2 text-[12px] font-normal">
        <PlanHoverCardDetail icon={ShieldWarningIcon} text={`Risk · ${risk}`} />
        <PlanHoverCardDetail
          icon={RulerIcon}
          text={`Change size · ${changeSize}`}
        />
        <PlanHoverCardDetail
          icon={ClockCounterClockwiseIcon}
          text={`${card.version} ${card.version === 1 ? "revision" : "revisions"}`}
        />
      </div>
    </div>
  );
}

function PlanHoverCardDetail({
  icon: Icon,
  text,
}: {
  icon: typeof ShieldWarningIcon;
  text: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon
        className="size-4 shrink-0 text-kumo-subtle"
        weight="regular"
        aria-hidden="true"
      />
      <span className="truncate">{text}</span>
    </div>
  );
}

function formatPlanDate(value: string | undefined): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function planRiskLabel(health: PlanHealthAssessment | undefined): string {
  if (!health) return "Unknown";
  const { level } = health.assessments.risk;
  const label = `${level[0]!.toUpperCase()}${level.slice(1)}`;
  return health.staleAt ? `${label} · stale` : label;
}

function planChangeSizeLabel(health: PlanHealthAssessment | undefined): string {
  if (!health) return "Unknown";
  const { size } = health.assessments.changeSize;
  const label = `${size[0]!.toUpperCase()}${size.slice(1)}`;
  return health.staleAt ? `${label} · stale` : label;
}

function planUpdateCount(
  plan: PlanArtifact,
  explicitCounts: Readonly<Record<string, number>>,
  attentionPlanIds: ReadonlySet<string>,
): number {
  const explicit = explicitCounts[plan.id];
  if (explicit !== undefined) return explicit;
  return !["completed", "archived"].includes(plan.status ?? "draft") &&
    attentionPlanIds.has(plan.id)
    ? 1
    : 0;
}

function PlanContextMenu({
  state,
  onStart,
}: {
  state: PlanContextMenuState;
  onStart: (configure: boolean) => void;
}) {
  return (
    <div
      role="menu"
      aria-label={`Actions for ${state.plan.title || "Untitled plan"}`}
      data-plan-context-menu
      className="tiller-dropdown-panel fixed z-50 w-[13.5rem] overflow-hidden text-kumo-default"
      style={{ left: state.x, top: state.y }}
    >
      <button
        type="button"
        role="menuitem"
        autoFocus
        onClick={() => onStart(false)}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] font-medium"
      >
        <RocketLaunchIcon
          className="size-4 shrink-0"
          weight="regular"
          aria-hidden="true"
        />
        <span>Start implementation</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onStart(true)}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] font-normal"
      >
        <SlidersHorizontalIcon
          className="size-4 shrink-0"
          weight="regular"
          aria-hidden="true"
        />
        <span>Start with options…</span>
      </button>
    </div>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}
