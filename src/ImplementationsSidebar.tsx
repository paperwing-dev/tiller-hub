import {
  CloudIcon,
  ClipboardTextIcon,
  DesktopTowerIcon,
  DiamondIcon,
  GitBranchIcon,
  PlusIcon,
  RobotIcon,
  RocketLaunchIcon,
} from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EnvMeta, EnvStatus } from "../api/types";
import type { PlanArtifact } from "../api/coordination/types";
import { useDashboardData } from "./DashboardDataProvider";
import { getEnvModelLabel, getHarnessBadgeLabel } from "./env-harness";
import { planWriterEffortLabel } from "./PlanWriterModelPicker";
import WorkspaceMetadata from "./WorkspaceMetadata";
import { WORKSPACE_CARD_ROW_CLASS } from "./workspace-card-style";

interface ImplementationsSidebarProps {
  repoId: string;
  envs?: EnvMeta[];
  plan: PlanArtifact | null;
  plans: PlanArtifact[];
  selectedEnvSlug?: string | null;
  startingImplementation?: boolean;
  onSelect: (envSlug: string) => void;
  onStartFresh: () => void;
  onStartWithPlan: () => void;
}

type CardTone = "live" | "attention" | "transient" | "warning" | "update" | "neutral";

interface HoverCardState {
  label: string;
  updatedAt: string;
  runtime: string;
  backend: EnvMeta["backend"];
  branch: string;
  top: number;
  left: number;
}

function belongsToPlan(env: EnvMeta, plan: PlanArtifact): boolean {
  return env.startupPlanId === plan.id;
}

export function planForEnvironment(env: EnvMeta, plans: PlanArtifact[]): PlanArtifact | null {
  return plans.find((plan) => belongsToPlan(env, plan)) ?? null;
}

export function implementationDisplayName(env: EnvMeta, plans: PlanArtifact[]): string {
  const planTitle = planForEnvironment(env, plans)?.title.trim();
  if (planTitle) return planTitle;

  const explicitName = env.displayName?.trim();
  if (explicitName && explicitName !== env.slug) return explicitName;
  return env.startupPlanId ? "Implementation" : "Fresh implementation";
}

export function implementationHasShipTarget(env: EnvMeta): boolean {
  return Boolean(
    env.workspaceDirty
    || env.branchStatus === "ready-to-merge"
    || env.branchStatus === "needs-attention"
    || env.githubPrUrl
    || env.githubPublishStatus === "publishing"
    || env.githubPublishStatus === "failed"
    || (
      env.githubHeadCommitSha
      && env.githubPublishStatus === "published"
      && env.githubPrState !== "closed"
      && env.githubPrState !== "merged"
      && !env.githubMergedAt
    )
  );
}

function lifecycleStatusLabel(status: EnvStatus): string {
  switch (status) {
    case "creating": return "Creating";
    case "starting": return "Starting";
    case "running": return "Running";
    case "saving": return "Saving";
    case "stopping": return "Stopping";
    case "stopped": return "Saved";
    case "failed": return "Needs attention";
    case "deleting": return "Deleting";
    default: return "Unknown";
  }
}

function statusDotClass(tone: CardTone): string {
  if (tone === "live") return "text-[#00a878]";
  if (tone === "attention") return "text-kumo-danger";
  if (tone === "transient" || tone === "warning") return "text-kumo-warning";
  if (tone === "update") return "text-[var(--paperwing-signal-update)]";
  return "text-kumo-info";
}

function implementationCardStatus(env: EnvMeta): { label: string; tone: CardTone } {
  if (implementationNeedsAttention(env)) return { label: "Needs attention", tone: "attention" };
  if (implementationHasUnreadUpdate(env)) return { label: "Waiting for you", tone: "update" };
  if (["creating", "starting", "saving", "stopping", "deleting"].includes(env.status)) {
    return { label: lifecycleStatusLabel(env.status), tone: "transient" };
  }
  if (env.status === "running") return { label: "Running", tone: "live" };
  if (env.githubPrNumber && env.githubPrState === "open") {
    return { label: `PR #${env.githubPrNumber} open`, tone: "update" };
  }
  if (env.branchStatus === "behind-main") return { label: "Behind project", tone: "warning" };
  if (env.workspaceDirty || env.branchStatus === "ready-to-merge") {
    return { label: "Changes ready", tone: "update" };
  }
  return { label: lifecycleStatusLabel(env.status), tone: "neutral" };
}

export function implementationRuntime(env: EnvMeta): string {
  const model = getEnvModelLabel(env);
  const effort = env.harnessSettings?.effort
    ? `${planWriterEffortLabel(env.harnessSettings.effort)} effort`
    : null;
  return [
    getHarnessBadgeLabel(env.harness),
    model,
    effort,
  ].filter(Boolean).join(" · ");
}

export function implementationExecutionLocation(backend: EnvMeta["backend"]): string {
  return backend === "host" ? "Your machine" : "Cloudflare Containers";
}

function implementationBranch(env: EnvMeta): string {
  const branch = env.githubBranch || env.branchName || "No branch yet";
  return env.githubPrNumber && env.githubPrState === "open"
    ? `PR #${env.githubPrNumber} · ${branch}`
    : branch;
}

function formatCompactAge(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo`;
  return `${Math.floor(elapsedMonths / 12)}y`;
}

function formatUpdatedAge(value: string): string {
  const age = formatCompactAge(value);
  if (age === "now") return "Updated now";
  if (age === "recently") return "Updated recently";
  return `Updated ${age} ago`;
}

export default function ImplementationsSidebar({
  repoId,
  envs,
  plan,
  plans,
  selectedEnvSlug = null,
  startingImplementation = false,
  onSelect,
  onStartFresh,
  onStartWithPlan,
}: ImplementationsSidebarProps) {
  const data = useDashboardData();
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);
  const [createMenuPosition, setCreateMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const implementations = (envs ?? data.envs)
    .filter((env) => env.repoId === repoId)
    .sort((left, right) => {
      const leftCurrent = plan ? belongsToPlan(left, plan) : false;
      const rightCurrent = plan ? belongsToPlan(right, plan) : false;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return left.slug.localeCompare(right.slug);
  });
  const attentionCount = implementations.filter((env) => implementationNeedsAttention(env)).length;
  const updateCount = implementations.filter((env) => implementationHasUnreadUpdate(env)).length;

  useEffect(() => {
    if (!createMenuPosition) return;
    const closeForPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-implementation-create-menu]")) return;
      if (event.target === createButtonRef.current || createButtonRef.current?.contains(event.target as Node)) return;
      setCreateMenuPosition(null);
    };
    const closeForKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setCreateMenuPosition(null);
        createButtonRef.current?.focus();
      }
    };
    const closeForBlur = () => setCreateMenuPosition(null);
    window.addEventListener("pointerdown", closeForPointer);
    window.addEventListener("keydown", closeForKey);
    window.addEventListener("blur", closeForBlur);
    return () => {
      window.removeEventListener("pointerdown", closeForPointer);
      window.removeEventListener("keydown", closeForKey);
      window.removeEventListener("blur", closeForBlur);
    };
  }, [createMenuPosition]);

  useEffect(() => {
    if (startingImplementation) setHoverCard(null);
  }, [startingImplementation]);

  const toggleCreateMenu = () => {
    if (createMenuPosition) {
      setCreateMenuPosition(null);
      return;
    }
    const rect = createButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 208;
    setCreateMenuPosition({
      top: Math.min(window.innerHeight - 88, rect.bottom + 4),
      left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
    });
  };

  return (
    <section data-testid="implementations-section" className="tiller-workspace-sidebar flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-kumo-recessed">
      <div className="tiller-hover-count-metadata tiller-workspace-sidebar-header flex h-11 shrink-0 items-center border-b border-kumo-line">
        <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
          <span className="min-w-0 truncate text-[13px] font-semibold text-kumo-default">
            Implementations
          </span>
          <WorkspaceMetadata
            count={implementations.length}
            warning={{
              count: attentionCount,
              label: `${attentionCount} ${attentionCount === 1 ? "implementation needs" : "implementations need"} attention`,
            }}
            update={{
              count: updateCount,
              label: `${updateCount} ${updateCount === 1 ? "implementation is" : "implementations are"} waiting for you`,
            }}
            className="tiller-workspace-sidebar-meta text-kumo-default"
          />
        </div>
        <Tooltip
          content={startingImplementation ? "Starting implementation" : "Create implementation"}
          side="bottom"
          align="end"
          delay={250}
          render={(
            <button
              ref={createButtonRef}
              type="button"
              onClick={toggleCreateMenu}
              disabled={startingImplementation}
              aria-label={startingImplementation ? "Starting implementation" : "Create implementation"}
              aria-haspopup="menu"
              aria-expanded={Boolean(createMenuPosition)}
              aria-controls={createMenuPosition ? "implementation-create-menu" : undefined}
              className="tiller-workspace-sidebar-action relative mr-3 flex size-8 shrink-0 items-center justify-center text-kumo-default disabled:opacity-50"
            />
          )}
        >
          <PlusIcon className="size-3.5 shrink-0" weight="bold" aria-hidden="true" />
        </Tooltip>
      </div>

      {createMenuPosition && createPortal(
        <div
          id="implementation-create-menu"
          role="menu"
          aria-label="Create implementation"
          data-implementation-create-menu
          className="tiller-dropdown-panel fixed z-50 w-52 overflow-hidden text-kumo-default"
          style={createMenuPosition}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              setCreateMenuPosition(null);
              onStartFresh();
            }}
            className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] font-medium"
          >
            <RocketLaunchIcon className="size-4 shrink-0" weight="regular" aria-hidden="true" />
            <span>Start fresh</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCreateMenuPosition(null);
              onStartWithPlan();
            }}
            className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] font-normal"
          >
            <ClipboardTextIcon className="size-4 shrink-0" weight="regular" aria-hidden="true" />
            <span>Start with plan…</span>
          </button>
        </div>,
        document.body,
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
        {implementations.length === 0 ? (
          <div className="px-10 py-3 text-xs leading-relaxed text-kumo-subtle">
            No implementations yet.
          </div>
        ) : (
          <div data-testid="implementation-card-stack" className="grid gap-1">
            {implementations.map((env) => {
              const implementationPlan = planForEnvironment(env, plans);
              const current = implementationPlan?.id === plan?.id;
              const selected = env.slug === selectedEnvSlug;
              const label = implementationDisplayName(env, plans);
              const cardStatus = implementationCardStatus(env);
              const runtime = implementationRuntime(env);
              const branch = implementationBranch(env);
              const descriptionId = `implementation-card-description-${env.slug}`;
              const showHoverCard = (element: HTMLButtonElement) => {
                if (startingImplementation) return;
                const rect = element.getBoundingClientRect();
                const cardWidth = 304;
                const cardHeight = 152;
                const preferredLeft = rect.right + 8;
                const left = preferredLeft + cardWidth <= window.innerWidth - 16
                  ? preferredLeft
                  : Math.max(16, rect.left - cardWidth - 8);
                const top = Math.max(16, Math.min(rect.top - 4, window.innerHeight - cardHeight - 16));
                setHoverCard({
                  label,
                  updatedAt: env.updatedAt,
                  runtime,
                  backend: env.backend,
                  branch,
                  top,
                  left,
                });
              };
              return (
                <button
                  key={env.slug}
                  type="button"
                  onClick={() => {
                    setHoverCard(null);
                    onSelect(env.slug);
                  }}
                  onMouseEnter={(event) => showHoverCard(event.currentTarget)}
                  onMouseLeave={() => setHoverCard(null)}
                  onFocus={(event) => showHoverCard(event.currentTarget)}
                  onBlur={() => setHoverCard(null)}
                  aria-label={`${label}, ${cardStatus.label}`}
                  aria-describedby={descriptionId}
                  aria-current={selected ? "page" : undefined}
                  className={`${WORKSPACE_CARD_ROW_CLASS} ${
                    current ? "tiller-implementation-index-row-related" : ""
                  } ${
                    selected ? "tiller-implementation-index-row-selected" : ""
                  }`}
                >
                  <span className="flex items-start gap-2">
                    {implementationHasUnreadUpdate(env) && !implementationNeedsAttention(env) ? (
                      <DiamondIcon
                        data-implementation-update="unread"
                        data-implementation-card-tone={cardStatus.tone}
                        className={`mt-[6px] block size-[7px] shrink-0 ${statusDotClass(cardStatus.tone)}`}
                        weight="fill"
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        data-implementation-status={env.status}
                        data-implementation-card-tone={cardStatus.tone}
                        className={`mt-[7px] block size-[6px] shrink-0 rounded-full bg-current ${statusDotClass(cardStatus.tone)}`}
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-kumo-default">{label}</span>
                        <span
                          data-implementation-card-status={cardStatus.tone}
                          className="tiller-implementation-card-status tiller-workspace-sidebar-meta mr-2 shrink-0 text-right text-[11px] font-normal text-kumo-default"
                        >
                          <span>{cardStatus.label}</span>
                        </span>
                      </span>
                      <span id={descriptionId} className="sr-only">
                        {runtime}. {implementationExecutionLocation(env.backend)}. {branch}. {formatUpdatedAge(env.updatedAt)}.
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {hoverCard && <ImplementationHoverCard card={hoverCard} />}
    </section>
  );
}

function ImplementationHoverCard({ card }: { card: HoverCardState }) {
  return (
    <div
      role="tooltip"
      data-testid="implementation-hover-card"
      className="tiller-card-surface tiller-floating-surface pointer-events-none fixed z-50 w-[19rem] border border-kumo-line bg-kumo-recessed px-4 py-3 text-kumo-default"
      style={{ top: card.top, left: card.left }}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-4">
        <span className="truncate text-[13px] font-semibold">{card.label}</span>
        <span className="shrink-0 font-mono text-[11px] font-normal tabular-nums text-kumo-subtle">
          {formatCompactAge(card.updatedAt)}
        </span>
      </div>
      <div className="mt-3 space-y-2 text-[12px] font-normal">
        <HoverCardDetail icon={RobotIcon} text={card.runtime} />
        <HoverCardDetail
          icon={card.backend === "host" ? DesktopTowerIcon : CloudIcon}
          text={implementationExecutionLocation(card.backend)}
        />
        <HoverCardDetail icon={GitBranchIcon} text={card.branch} />
      </div>
    </div>
  );
}

function HoverCardDetail({
  icon: Icon,
  text,
}: {
  icon: typeof ClipboardTextIcon;
  text: string;
}) {
  return (
    <div data-implementation-hover-detail className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-kumo-subtle" weight="regular" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </div>
  );
}

export function implementationNeedsAttention(env: EnvMeta): boolean {
  return env.status === "failed"
    || env.branchStatus === "needs-attention"
    || env.workspaceNeedsAttention === true;
}

export function implementationHasUnreadUpdate(env: EnvMeta): boolean {
  return Boolean(env.implementorAttentionToken);
}
