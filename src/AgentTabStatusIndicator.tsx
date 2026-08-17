import React from "react";
import { DiamondIcon } from "@phosphor-icons/react";

export type AgentTabStatusKind =
  | "idle"
  | "running"
  | "starting"
  | "working"
  | "saving"
  | "stopping"
  | "finished"
  | "viewed"
  | "stopped"
  | "error";

export interface AgentTabStatus {
  kind: AgentTabStatusKind;
  label: string;
  detail: string;
  runId?: string;
}

export default function AgentTabStatusIndicator({
  status,
  card = false,
}: {
  status: AgentTabStatus;
  card?: boolean;
}) {
  const transient = status.kind === "starting"
    || status.kind === "working"
    || status.kind === "saving"
    || status.kind === "stopping";
  const active = status.kind === "running" || status.kind === "finished";
  // A returned response remains discoverable after it has been opened. Fill is
  // reserved for an unread response; the outline is the quieter viewed state.
  const visibleCardSignal = status.kind === "running"
    || status.kind === "finished"
    || status.kind === "viewed"
    || status.kind === "error";
  const color = status.kind === "error"
    ? "text-kumo-danger"
    : status.kind === "running" || status.kind === "working"
      ? "text-[var(--paperwing-signal-live)]"
      : status.kind === "finished"
      ? "text-[var(--paperwing-signal-update)]"
      : transient
        ? "text-kumo-info"
        : "text-kumo-subtle";

  if (card) {
    if (transient) {
      return (
        <span
          data-agent-tab-status={status.kind}
          data-agent-card-signal
          className="block size-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    }
    if (!visibleCardSignal) {
      return (
        <span
          data-agent-card-signal-placeholder
          className="block size-[7px] shrink-0"
          aria-hidden="true"
        />
      );
    }
    return (
      <DiamondIcon
        data-agent-tab-status={status.kind}
        data-agent-card-signal
        className={`block size-[7px] shrink-0 ${color}`}
        weight={status.kind === "viewed" ? "regular" : "fill"}
        aria-hidden="true"
      />
    );
  }

  if (transient) {
    return (
      <DiamondIcon
        data-agent-tab-status={status.kind}
        className={`block size-3 shrink-0 animate-spin motion-reduce:animate-none ${color}`}
        weight="regular"
        aria-hidden="true"
      />
    );
  }
  return (
    <DiamondIcon
      data-agent-tab-status={status.kind}
      className={`block size-3 shrink-0 ${color}`}
      weight={active ? "fill" : "regular"}
      aria-hidden="true"
    />
  );
}
