import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Popover } from "@cloudflare/kumo/components/popover";
import { CaretRightIcon, DotsThreeIcon, GearSixIcon } from "@phosphor-icons/react";
import type { AgentSkillDefinition, ReviewerRegistryEntry } from "../api/coordination/types";
import AddReviewerMenu, {
  type AddReviewerAction,
} from "./AddReviewerMenu";
import type { PlannerProviderMetadata } from "./api";
import AgentTabButton from "./AgentTabButton";
import AgentTabStatusIndicator from "./AgentTabStatusIndicator";
import type { PlanTabStatus } from "./plan-tab-status";
import { PLAN_AGENT_LABEL } from "./plan-agent-copy";
import { getHarnessBadgeLabel } from "./env-harness";
import { resolveReviewerRailKeyboardAction } from "./reviewer-rail-keyboard";

interface PlanChatTabsProps {
  reviewers: ReviewerRegistryEntry[];
  providers: PlannerProviderMetadata[];
  activeTab: string;
  writerTabStatus: PlanTabStatus;
  writerNeedsAttention?: boolean;
  pendingScribeCount?: number;
  reviewerTabStatuses?: ReadonlyMap<string, PlanTabStatus>;
  adding?: boolean;
  reviewerDialogOpen?: boolean;
  onActiveTabChange: (tab: string) => void;
  onReviewerDialogOpenChange?: (open: boolean) => void;
  onOpenPlanSkills?: () => void;
  onAddReviewer: (input: AddReviewerAction) => void;
  skills?: AgentSkillDefinition[];
  onInvokeSkill?: (skill: AgentSkillDefinition) => void;
  onCloseReviewer: (threadId: string) => void;
  onOpenReviewerSettings?: (threadId: string) => void;
  onWriterSettings?: () => void;
  onStopWriter?: () => void;
  writerStopDisabled?: boolean;
  writerLabel?: string;
  writerTerminalMetadata?: TerminalProcessMetadata;
  compact?: boolean;
}

export interface TerminalProcessMetadata {
  harness: string;
  model: string;
  effort?: string;
}

interface TerminalHoverCardState extends TerminalProcessMetadata {
  label: string;
  status: PlanTabStatus;
  top: number;
  left: number;
}

export default function PlanChatTabs({
  reviewers,
  providers,
  activeTab,
  writerTabStatus,
  writerNeedsAttention = false,
  pendingScribeCount = 0,
  reviewerTabStatuses = new Map(),
  adding = false,
  reviewerDialogOpen,
  onActiveTabChange,
  onReviewerDialogOpenChange,
  onOpenPlanSkills,
  onAddReviewer,
  skills = [],
  onInvokeSkill,
  onCloseReviewer,
  onOpenReviewerSettings,
  onWriterSettings,
  onStopWriter,
  writerStopDisabled = false,
  writerLabel = PLAN_AGENT_LABEL,
  writerTerminalMetadata,
  compact = false,
}: PlanChatTabsProps) {
  const modelTabLabels = getReviewerTabLabels(reviewers, providers);
  const tabLabels = compact ? getReviewerRoleLabels(reviewers) : modelTabLabels;
  const reviewerMetadata = getReviewerTerminalMetadata(reviewers, providers);
  const activeReviewer = reviewers.find((reviewer) => reviewer.threadId === activeTab) ?? null;
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const activeReviewer = reviewers.find((reviewer) => reviewer.threadId === activeTab);
    if (activeReviewer?.nodeKind !== "report" || !activeReviewer.skillRootThreadId) return;
    setExpandedRoots((current) => {
      if (current.has(activeReviewer.skillRootThreadId!)) return current;
      return new Set([...current, activeReviewer.skillRootThreadId!]);
    });
  }, [activeTab, reviewers]);
  const visibleReviewers = useMemo(
    () =>
      reviewers.filter(
        (reviewer) =>
          reviewer.nodeKind !== "report" ||
          Boolean(
            reviewer.skillRootThreadId &&
              expandedRoots.has(reviewer.skillRootThreadId),
          ),
      ),
    [expandedRoots, reviewers],
  );
  const genericReviewerCount = reviewers.filter(
    (reviewer) => reviewer.nodeKind === "generic",
  ).length;
  const railKeyboardNodes = [
    { id: "writer" },
    ...visibleReviewers.map((reviewer) => {
      const reports = reviewer.nodeKind === "skill_root"
        ? reviewers.filter(
            (candidate) =>
              candidate.nodeKind === "report" &&
              candidate.skillRootThreadId === reviewer.threadId,
          )
        : [];
      return {
        id: reviewer.threadId,
        ...(reviewer.nodeKind === "report" && reviewer.skillRootThreadId
          ? { parentId: reviewer.skillRootThreadId }
          : {}),
        ...(reports.length > 0
          ? {
              expandable: true,
              expanded: expandedRoots.has(reviewer.threadId),
              firstChildId: reports[0]!.threadId,
            }
          : {}),
      };
    }),
  ];
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const writerActionRef = useRef<HTMLButtonElement | null>(null);
  const reviewerActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [reviewerActionsOpen, setReviewerActionsOpen] = useState<string | null>(null);
  const [writerActionsOpen, setWriterActionsOpen] = useState(false);
  const [terminalHoverCard, setTerminalHoverCard] = useState<TerminalHoverCardState | null>(null);

  const showTerminalHoverCard = (
    element: HTMLButtonElement,
    label: string,
    status: PlanTabStatus,
    metadata: TerminalProcessMetadata | undefined,
  ) => {
    if (!metadata) return;
    const rect = element.getBoundingClientRect();
    const cardWidth = 272;
    const cardHeight = metadata.effort ? 148 : 120;
    const preferredLeft = rect.left - cardWidth - 8;
    const left = preferredLeft >= 16
      ? preferredLeft
      : Math.min(window.innerWidth - cardWidth - 16, rect.right + 8);
    const top = Math.max(16, Math.min(rect.top - 4, window.innerHeight - cardHeight - 16));
    setTerminalHoverCard({ label, status, ...metadata, top, left });
  };

  const moveTreeFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentTab: string,
  ) => {
    const action = resolveReviewerRailKeyboardAction(
      event.key,
      currentTab,
      railKeyboardNodes,
    );
    if (!action) return;
    event.preventDefault();
    if (action.kind === "expand" || action.kind === "collapse") {
      setExpandedRoots((current) => {
        const next = new Set(current);
        if (action.kind === "expand") next.add(action.id);
        else next.delete(action.id);
        return next;
      });
      return;
    }
    onActiveTabChange(action.id);
    tabRefs.current.get(action.id)?.focus();
  };

  const registerTab = (tab: string) => (node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(tab, node);
    else tabRefs.current.delete(tab);
  };

  const registerReviewerAction = (threadId: string) => (node: HTMLButtonElement | null) => {
    if (node) reviewerActionRefs.current.set(threadId, node);
    else reviewerActionRefs.current.delete(threadId);
  };

  const writerActionsAvailable = Boolean(onWriterSettings || onStopWriter);
  const openWriterActions = () => {
    if (!writerActionsAvailable) return;
    setTerminalHoverCard(null);
    onActiveTabChange("writer");
    setWriterActionsOpen(true);
  };
  const openReviewerActions = (threadId: string) => {
    setTerminalHoverCard(null);
    onActiveTabChange(threadId);
    setReviewerActionsOpen(threadId);
  };

  if (compact) {
    return (
      <>
        <aside className="tiller-agent-switcher order-2 flex w-56 shrink-0 flex-col border-l border-kumo-line bg-kumo-base">
        <div className="tiller-agent-switcher-header tiller-workspace-sidebar-header flex h-12 shrink-0 items-center gap-1 border-b border-kumo-line px-3">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-kumo-default">
            Reviewers
          </span>
          {onOpenPlanSkills && (
            <button
              type="button"
              className="tiller-workspace-sidebar-action flex size-8 shrink-0 items-center justify-center text-kumo-default"
              aria-label="Reviewer skill settings"
              onClick={onOpenPlanSkills}
            >
              <GearSixIcon className="size-3.5" weight="bold" aria-hidden="true" />
            </button>
          )}
          <AddReviewerMenu
            activeReviewerCount={genericReviewerCount}
            providers={providers}
            disabled={adding}
            open={reviewerDialogOpen}
            onOpenChange={onReviewerDialogOpenChange}
            compact
            iconOnly
            onAdd={onAddReviewer}
            skills={skills}
            onInvokeSkill={onInvokeSkill}
          />
        </div>
        <div
          role="tree"
          aria-label="Plan conversations"
          aria-orientation="vertical"
          className="tiller-agent-card-stack grid min-h-0 content-start gap-0 overflow-y-auto p-2"
        >
          <div role="presentation" className="tiller-interface-label px-2 pb-1 pt-1 text-[10px] font-medium text-kumo-default">
            Edits the plan
          </div>
          <Popover open={writerActionsOpen} onOpenChange={setWriterActionsOpen}>
            <div
              className={`tiller-plan-agent-list-item flex h-11 w-full min-w-0 items-stretch ${activeTab === "writer" ? "tiller-plan-agent-row-selected" : ""}`}
            >
              <AgentTabButton
                id="plan-agent-tab-writer"
                controls="plan-agent-panel"
                label={writerLabel}
                status={writerTabStatus}
                active={activeTab === "writer"}
                onClick={() => {
                  setTerminalHoverCard(null);
                  onActiveTabChange("writer");
                }}
                onMouseEnter={(event) => showTerminalHoverCard(
                  event.currentTarget,
                  writerLabel,
                  writerTabStatus,
                  writerTerminalMetadata,
                )}
                onMouseLeave={() => setTerminalHoverCard(null)}
                onFocus={(event) => showTerminalHoverCard(
                  event.currentTarget,
                  writerLabel,
                  writerTabStatus,
                  writerTerminalMetadata,
                )}
                onBlur={() => setTerminalHoverCard(null)}
                onContextMenu={(event) => {
                  if (!writerActionsAvailable) return;
                  event.preventDefault();
                  openWriterActions();
                }}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                    event.preventDefault();
                    openWriterActions();
                    return;
                  }
                  moveTreeFocus(event, "writer");
                }}
                buttonRef={registerTab("writer")}
                tabIndex={activeTab === "writer" ? 0 : -1}
                semanticRole="treeitem"
                ariaLevel={1}
                orientation="vertical"
                primary
                compact
                showStatusLabel
                compactWithSibling={activeTab === "writer" && writerActionsAvailable}
                needsAttention={writerNeedsAttention}
              />
              {activeTab === "writer" && writerActionsAvailable && (
                <button
                  ref={writerActionRef}
                  type="button"
                  tabIndex={-1}
                  aria-label={`Actions for ${writerLabel}`}
                  aria-expanded={writerActionsOpen}
                  onClick={() => {
                    setTerminalHoverCard(null);
                    setWriterActionsOpen((current) => !current);
                  }}
                  className="tiller-plan-agent-action flex h-11 w-10 shrink-0 items-center justify-center text-current hover:bg-white/10"
                >
                  <DotsThreeIcon className="size-4" weight="bold" aria-hidden="true" />
                </button>
              )}
            </div>
            {writerActionsAvailable && (
              <Popover.Content
                anchor={writerActionRef.current ?? tabRefs.current.get("writer") ?? null}
                side="left"
                align="start"
                sideOffset={6}
                positionMethod="fixed"
                className="w-44 p-1"
              >
                <div className="tiller-plan-agent-actions-menu" role="menu" aria-label={`${writerLabel} actions`}>
                  {onWriterSettings && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setWriterActionsOpen(false);
                        onWriterSettings();
                      }}
                      className="flex w-full px-2 py-1.5 text-left text-[13px] text-kumo-default hover:bg-kumo-tint"
                    >
                      {writerLabel} settings
                    </button>
                  )}
                  {onStopWriter && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={writerStopDisabled}
                      onClick={() => {
                        setWriterActionsOpen(false);
                        onStopWriter();
                      }}
                      className="flex w-full px-2 py-1.5 text-left text-[13px] text-kumo-danger hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Stop {writerLabel}
                    </button>
                  )}
                </div>
              </Popover.Content>
            )}
          </Popover>
          <div
            role="presentation"
            className="mt-2 flex h-8 items-center justify-between border-t border-kumo-line pl-2"
          >
            <span className="tiller-interface-label text-[10px] font-medium text-kumo-default">
              Advises on this plan
            </span>
          </div>
          {visibleReviewers.map((reviewer) => {
            const label = tabLabels.get(reviewer.threadId) ?? "Reviewer";
            const detailedLabel = modelTabLabels.get(reviewer.threadId) ?? label;
            const metadata = reviewerMetadata.get(reviewer.threadId);
            const status = reviewerTabStatuses.get(reviewer.threadId) ?? READY_REVIEWER_STATUS;
            const active = activeTab === reviewer.threadId;
            return (
              <div
                key={reviewer.threadId}
                role="presentation"
                className={`tiller-plan-agent-list-item flex h-11 w-full min-w-0 items-stretch ${reviewer.nodeKind === "report" ? "tiller-plan-agent-list-item--report pl-4" : ""} ${active ? "tiller-plan-agent-row-selected" : ""}`}
              >
                {reviewer.nodeKind === "skill_root" && reviewers.some(
                  (candidate) =>
                    candidate.nodeKind === "report" &&
                    candidate.skillRootThreadId === reviewer.threadId,
                ) && (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="flex w-6 shrink-0 items-center justify-center text-kumo-subtle hover:text-kumo-default"
                    aria-label={`${expandedRoots.has(reviewer.threadId) ? "Collapse" : "Expand"} ${label} Reports`}
                    aria-expanded={expandedRoots.has(reviewer.threadId)}
                    onClick={() =>
                      setExpandedRoots((current) => {
                        const next = new Set(current);
                        if (next.has(reviewer.threadId)) next.delete(reviewer.threadId);
                        else next.add(reviewer.threadId);
                        return next;
                      })
                    }
                  >
                    <CaretRightIcon
                      className={`size-3 transition-transform ${expandedRoots.has(reviewer.threadId) ? "rotate-90" : ""}`}
                      weight="bold"
                      aria-hidden="true"
                    />
                  </button>
                )}
                <AgentTabButton
                  id={agentTabId(reviewer.threadId)}
                  controls="plan-agent-panel"
                  label={label}
                  accessibleLabel={detailedLabel}
                  status={status}
                  active={active}
                  onClick={() => {
                    setTerminalHoverCard(null);
                    onActiveTabChange(reviewer.threadId);
                  }}
                  onMouseEnter={(event) => showTerminalHoverCard(
                    event.currentTarget,
                    label,
                    status,
                    metadata,
                  )}
                  onMouseLeave={() => setTerminalHoverCard(null)}
                  onFocus={(event) => showTerminalHoverCard(
                    event.currentTarget,
                    label,
                    status,
                    metadata,
                  )}
                  onBlur={() => setTerminalHoverCard(null)}
                  onContextMenu={(event) => {
                    if (reviewer.nodeKind === "report") return;
                    event.preventDefault();
                    openReviewerActions(reviewer.threadId);
                  }}
                  onKeyDown={(event) => {
                    if (
                      reviewer.nodeKind !== "report" &&
                      (event.key === "ContextMenu" ||
                        (event.key === "F10" && event.shiftKey))
                    ) {
                      event.preventDefault();
                      openReviewerActions(reviewer.threadId);
                      return;
                    }
                    moveTreeFocus(event, reviewer.threadId);
                  }}
                  buttonRef={registerTab(reviewer.threadId)}
                  tabIndex={active ? 0 : -1}
                  semanticRole="treeitem"
                  ariaLevel={reviewer.nodeKind === "report" ? 2 : 1}
                  ariaExpanded={reviewer.nodeKind === "skill_root" && reviewers.some(
                    (candidate) =>
                      candidate.nodeKind === "report" &&
                      candidate.skillRootThreadId === reviewer.threadId,
                  )
                    ? expandedRoots.has(reviewer.threadId)
                    : undefined}
                  orientation="vertical"
                  primary
                  compact
                  showStatusLabel
                  compactWithSibling={active}
                />
                {active && reviewer.nodeKind !== "report" && (
                  <Popover
                    open={reviewerActionsOpen === reviewer.threadId}
                    onOpenChange={(open) => setReviewerActionsOpen(open ? reviewer.threadId : null)}
                  >
                    <button
                      ref={registerReviewerAction(reviewer.threadId)}
                      type="button"
                      tabIndex={-1}
                      aria-label={`Actions for ${detailedLabel}`}
                      aria-expanded={reviewerActionsOpen === reviewer.threadId}
                      onClick={() => setReviewerActionsOpen((current) => (
                        current === reviewer.threadId ? null : reviewer.threadId
                      ))}
                      className="tiller-plan-agent-action flex h-11 w-10 shrink-0 items-center justify-center text-current hover:bg-white/10"
                    >
                      <DotsThreeIcon className="size-4" weight="bold" aria-hidden="true" />
                    </button>
                    <Popover.Content
                      anchor={reviewerActionRefs.current.get(reviewer.threadId) ?? null}
                      side="left"
                      align="start"
                      sideOffset={6}
                      positionMethod="fixed"
                      className="w-44 p-1"
                    >
                      <div className="tiller-plan-agent-actions-menu" role="menu" aria-label={`${detailedLabel} actions`}>
                        {onOpenReviewerSettings && reviewer.nodeKind === "generic" && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setReviewerActionsOpen(null);
                              onOpenReviewerSettings(reviewer.threadId);
                            }}
                            className="flex w-full px-2 py-1.5 text-left text-[13px] text-kumo-default hover:bg-kumo-tint"
                          >
                            Reviewer settings
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setReviewerActionsOpen(null);
                            onCloseReviewer(reviewer.threadId);
                          }}
                          className="flex w-full px-2 py-1.5 text-left text-[13px] text-kumo-danger hover:bg-kumo-tint"
                        >
                          {reviewer.nodeKind === "skill_root" ? "Remove skill" : "Remove reviewer"}
                        </button>
                      </div>
                    </Popover.Content>
                  </Popover>
                )}
              </div>
            );
          })}
        </div>
        </aside>
        {terminalHoverCard && createPortal(
          <TerminalProcessHoverCard card={terminalHoverCard} />,
          document.body,
        )}
      </>
    );
  }

  return (
    <div className="flex items-end justify-between gap-3 border-b border-kumo-line bg-kumo-recessed px-3 py-2">
      <div className="flex min-w-0 flex-1 items-stretch gap-3" aria-label="Plan collaborators">
        <div role="group" aria-label="Edits the plan" className="flex shrink-0 flex-col justify-end gap-0.5">
          <span className="tiller-interface-label px-2 text-[10px] font-medium text-kumo-default">
            Edits the plan
          </span>
          <AgentTabButton
            label={writerLabel}
            status={writerTabStatus}
            active={activeTab === "writer"}
            onClick={() => onActiveTabChange("writer")}
            badge={pendingScribeCount}
            needsAttention={writerNeedsAttention}
          />
        </div>
        <span role="separator" aria-orientation="vertical" className="h-10 w-px shrink-0 self-end bg-kumo-line" />
        <div role="group" aria-label="Advises on this plan" className="flex min-w-0 flex-1 flex-col justify-end gap-0.5">
          <span className="tiller-interface-label px-2 text-[10px] font-medium text-kumo-default">
            Advises on this plan
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
              activeReviewerCount={genericReviewerCount}
              providers={providers}
              disabled={adding}
              label="+ Reviewer"
              open={reviewerDialogOpen}
              onOpenChange={onReviewerDialogOpenChange}
              onAdd={onAddReviewer}
              skills={skills}
              onInvokeSkill={onInvokeSkill}
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {activeReviewer && (
          <button
            type="button"
            onClick={() => onCloseReviewer(activeReviewer.threadId)}
            className="h-8 rounded border border-kumo-danger/30 bg-kumo-base px-2 text-xs font-medium text-kumo-danger hover:bg-kumo-danger-tint"
          >
            Remove reviewer
          </button>
        )}
        {onOpenPlanSkills && (
          <button
            type="button"
            onClick={onOpenPlanSkills}
            className="h-8 rounded border border-kumo-line bg-kumo-base px-2 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          >
            Plan Skills
          </button>
        )}
      </div>
    </div>
  );
}

function agentTabId(tab: string): string {
  return `plan-agent-tab-${tab.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

const READY_REVIEWER_STATUS: PlanTabStatus = {
  kind: "idle",
  label: "Ready",
  detail: "No review is in progress.",
};

// Reviewer tabs are labeled by the model's display name ("GPT 5.5"), numbered
// only when the same model is added more than once.
export function getReviewerTabLabels(
  reviewers: ReviewerRegistryEntry[],
  providers: PlannerProviderMetadata[],
  numberDuplicates = true,
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
    labels.set(
      reviewer.threadId,
      numberDuplicates && (totals.get(key) ?? 0) > 1 ? `${key} #${index}` : key,
    );
  }
  return labels;
}

export function getReviewerRoleLabels(
  reviewers: ReviewerRegistryEntry[],
): Map<string, string> {
  const generic = reviewers.filter((reviewer) => reviewer.nodeKind === "generic");
  return new Map(reviewers.map((reviewer) => {
    if (reviewer.displayLabel) return [reviewer.threadId, reviewer.displayLabel];
    if (reviewer.nodeKind === "report") return [reviewer.threadId, "Report"];
    const index = generic.findIndex((candidate) => candidate.threadId === reviewer.threadId);
    return [
      reviewer.threadId,
      generic.length === 1 ? "Reviewer" : `Reviewer ${Math.max(0, index) + 1}`,
    ];
  }));
}

export function getReviewerTerminalMetadata(
  reviewers: ReviewerRegistryEntry[],
  providers: PlannerProviderMetadata[],
): Map<string, TerminalProcessMetadata> {
  return new Map(reviewers.map((reviewer) => {
    const provider = providers.find((candidate) => candidate.id === reviewer.provider);
    const model = provider?.models.find((candidate) => candidate.id === reviewer.model);
    const effort = reviewer.effort ?? model?.defaultEffort ?? provider?.defaultEffort;
    const efforts = model?.efforts?.length ? model.efforts : provider?.efforts;
    const effortLabel = effort
      ? efforts?.find((candidate) => candidate.id === effort)?.displayName ?? formatEffort(effort)
      : undefined;
    return [reviewer.threadId, {
      harness: reviewerHarnessLabel(reviewer.provider, provider?.displayName),
      model: model?.displayName ?? reviewer.model,
      ...(effortLabel ? { effort: effortLabel } : {}),
    }];
  }));
}

function reviewerHarnessLabel(providerId: string, fallback?: string): string {
  if (providerId === "codex" || providerId === "claude-code" || providerId === "opencode") {
    return getHarnessBadgeLabel(providerId);
  }
  return fallback ?? providerId;
}

function TerminalProcessHoverCard({ card }: { card: TerminalHoverCardState }) {
  const responseReturned = card.status.kind === "finished" || card.status.kind === "viewed";
  return (
    <div
      role="tooltip"
      data-testid="terminal-process-hover-card"
      className="tiller-card-surface tiller-floating-surface pointer-events-none fixed z-50 w-[17rem] border border-kumo-line bg-kumo-recessed px-4 py-3 text-kumo-default"
      style={{ top: card.top, left: card.left }}
    >
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span className="truncate text-[13px] font-semibold">{card.label}</span>
        <span
          data-terminal-process-status={card.status.kind}
          className="flex shrink-0 items-center gap-1.5 text-[11px] font-normal text-kumo-subtle"
        >
          {responseReturned && <AgentTabStatusIndicator status={card.status} card />}
          {card.status.label}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px] font-normal">
        <dt className="text-kumo-subtle">Harness</dt>
        <dd className="truncate">{card.harness}</dd>
        <dt className="text-kumo-subtle">Model</dt>
        <dd className="truncate">{card.model}</dd>
        {card.effort && (
          <>
            <dt className="text-kumo-subtle">Reasoning</dt>
            <dd className="truncate">{card.effort}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function formatEffort(effort: string): string {
  if (effort === "xhigh") return "Extra High";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
