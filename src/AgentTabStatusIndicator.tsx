import React from "react";

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

export default function AgentTabStatusIndicator({ status }: { status: AgentTabStatus }) {
  const shared = "block shrink-0";

  if (status.kind === "idle") {
    return (
      <span
        data-agent-tab-status="idle"
        className={`${shared} h-2.5 w-2.5 rounded-full border border-kumo-subtle bg-kumo-base`}
        aria-hidden="true"
      />
    );
  }
  if (status.kind === "running") {
    return <span data-agent-tab-status="running" className={`${shared} h-2.5 w-2.5 rounded-full bg-kumo-success`} aria-hidden="true" />;
  }
  if (status.kind === "starting") {
    return <Spinner kind="starting" className="text-kumo-warning" />;
  }
  if (status.kind === "working" || status.kind === "saving" || status.kind === "stopping") {
    return <Spinner kind={status.kind} className="text-kumo-info" />;
  }
  if (status.kind === "finished") {
    return <span data-agent-tab-status="finished" className={`${shared} h-2.5 w-2.5 rounded-full bg-kumo-info`} aria-hidden="true" />;
  }
  if (status.kind === "viewed") {
    return (
      <svg
        data-agent-tab-status="viewed"
        viewBox="0 0 12 12"
        className={`${shared} h-3 w-3 text-kumo-subtle`}
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="m3.55 6.1 1.45 1.45 3.45-3.35" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status.kind === "stopped") {
    return (
      <svg
        data-agent-tab-status="stopped"
        viewBox="0 0 12 12"
        className={`${shared} h-3 w-3 text-kumo-subtle`}
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="5" fill="currentColor" />
        <rect x="4" y="4" width="4" height="4" rx="0.65" fill="white" />
      </svg>
    );
  }
  return (
    <svg
      data-agent-tab-status="error"
      viewBox="0 0 12 12"
      className={`${shared} h-3 w-3 text-kumo-danger`}
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="5" fill="currentColor" />
      <path d="m4.15 4.15 3.7 3.7m0-3.7-3.7 3.7" fill="none" stroke="white" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function Spinner({
  kind,
  className,
}: {
  kind: "starting" | "working" | "saving" | "stopping";
  className: string;
}) {
  return (
    <span
      data-agent-tab-status={kind}
      className={`block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none ${className}`}
      aria-hidden="true"
    />
  );
}
