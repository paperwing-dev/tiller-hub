import React from "react";
import { DiamondIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";

export interface WorkspaceSignalValue {
  count: number;
  label: string;
}

interface WorkspaceMetadataProps {
  count?: number;
  warning?: WorkspaceSignalValue;
  update?: WorkspaceSignalValue;
  className?: string;
}

export default function WorkspaceMetadata({
  count,
  warning,
  update,
  className = "",
}: WorkspaceMetadataProps) {
  return (
    <span
      data-workspace-metadata
      className={`tiller-workspace-metadata flex shrink-0 items-center gap-2 text-[11px] font-normal tabular-nums ${className}`}
    >
      {typeof count === "number" && (
        <span data-workspace-count>{count}</span>
      )}
      {warning && warning.count > 0 && (
        <WorkspaceSignal kind="warning" label={warning.label} />
      )}
      {update && update.count > 0 && (
        <WorkspaceSignal kind="update" label={update.label} />
      )}
    </span>
  );
}

export function WorkspaceSignal({
  kind,
  label,
}: {
  kind: "warning" | "update";
  label: string;
}) {
  return (
    <Tooltip
      content={label}
      side="top"
      delay={250}
      render={(
        <span
          data-workspace-signal={kind}
          className="tiller-workspace-signal flex size-3 shrink-0 items-center justify-center"
          aria-label={label}
        />
      )}
    >
      <DiamondIcon className="size-2.5" weight="fill" aria-hidden="true" />
    </Tooltip>
  );
}
