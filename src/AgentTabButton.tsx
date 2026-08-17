import React from "react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import AgentTabStatusIndicator, { type AgentTabStatus } from "./AgentTabStatusIndicator";

export default function AgentTabButton({
  label,
  status,
  active,
  onClick,
  compact = false,
  orientation = "horizontal",
  showStatusLabel = false,
  primary = false,
  accessibleLabel,
  title,
  id,
  controls,
  tabIndex,
  onKeyDown,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  buttonRef,
  semanticRole,
  ariaLevel,
  ariaExpanded,
  compactWithSibling = false,
  badge = 0,
  needsAttention = false,
}: {
  label: string;
  status: AgentTabStatus;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
  orientation?: "horizontal" | "vertical";
  showStatusLabel?: boolean;
  primary?: boolean;
  accessibleLabel?: string;
  title?: string;
  id?: string;
  controls?: string;
  tabIndex?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  semanticRole?: "tab" | "treeitem";
  ariaLevel?: number;
  ariaExpanded?: boolean;
  compactWithSibling?: boolean;
  badge?: number;
  needsAttention?: boolean;
}) {
  const vertical = orientation === "vertical";
  const semanticTab = semanticRole ? semanticRole === "tab" : Boolean(controls);
  const compactVertical = vertical && compact;
  const className = compactVertical
    ? `tiller-plan-agent-row flex h-11 min-w-0 items-center px-3 text-left ${compactWithSibling ? "w-0 flex-1" : "tiller-plan-agent-list-item w-full"} ${active ? (compactWithSibling ? "" : "tiller-plan-agent-row-selected") : "hover:bg-kumo-tint"}`
    : vertical
      ? `tiller-agent-tab tiller-agent-tab--vertical flex ${primary ? "h-10 px-3 text-[13px]" : "h-8 px-2.5 text-[12px]"} w-full min-w-0 items-center gap-2 border-b border-kumo-line text-left transition-colors ${
        active
          ? "bg-kumo-default font-semibold text-kumo-base"
          : "bg-kumo-base font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
      }`
    : compact
      ? `tiller-agent-tab relative -mb-px flex h-8 shrink-0 items-center gap-2 border px-3 text-[12px] transition-colors ${
        active
          ? "border-kumo-line border-b-kumo-base bg-kumo-base font-semibold text-kumo-default"
          : "border-transparent font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
      }`
      : `flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-1 text-[13px] ${
        active
          ? "border-kumo-brand text-kumo-default"
          : "border-transparent text-kumo-subtle hover:text-kumo-default"
      }`;
  const legacyContent = (
    <>
      <AgentTabStatusIndicator status={status} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {needsAttention && <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" aria-label="Needs attention" />}
      {badge > 0 && <span className="shrink-0 font-mono text-[10px] tabular-nums">{badge}</span>}
      {showStatusLabel && (
        <span className="tiller-agent-tab-metadata shrink-0 truncate font-mono text-[10px] font-normal opacity-75">
          {status.label}
        </span>
      )}
    </>
  );
  const cardContent = (
    <span className="flex h-full min-w-0 items-center gap-2">
      <AgentTabStatusIndicator status={status} card />
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-kumo-default">{label}</span>
          {needsAttention && <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" aria-label="Needs attention" />}
          {badge > 0 && <span className="shrink-0 font-mono text-[10px] tabular-nums text-kumo-subtle">{badge}</span>}
          {showStatusLabel && (
            <span className="tiller-workspace-sidebar-meta shrink-0 truncate text-right text-[10px] font-normal text-kumo-subtle">
              {status.label}
            </span>
          )}
        </span>
      </span>
    </span>
  );
  const buttonProps = {
    ref: buttonRef,
    id,
    type: "button" as const,
    role: semanticRole ?? (semanticTab ? "tab" : undefined),
    onClick,
    onKeyDown,
    onContextMenu,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
    tabIndex,
    title,
    "aria-label": `${accessibleLabel ?? label}, ${status.label}${badge > 0 ? `, ${badge} ${badge === 1 ? "item" : "items"} waiting` : ""}${needsAttention ? ", needs attention" : ""}`,
    "aria-description": status.detail,
    "aria-current": active ? "page" as const : undefined,
    "aria-selected": semanticTab ? active : undefined,
    "aria-level": ariaLevel,
    "aria-expanded": ariaExpanded,
    "aria-controls": controls,
    className,
  };

  if (vertical) return <button {...buttonProps}>{compactVertical ? cardContent : legacyContent}</button>;

  return (
    <Tooltip
      side="bottom"
      align="start"
      delay={250}
      content={(
        <div className="max-w-72">
          <div className="font-medium">{status.label}</div>
          <div className="mt-0.5 text-xs opacity-85">{status.detail}</div>
        </div>
      )}
      render={(
        <button {...buttonProps} />
      )}
    >
      {legacyContent}
    </Tooltip>
  );
}
