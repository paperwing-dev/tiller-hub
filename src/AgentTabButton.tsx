import React from "react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import AgentTabStatusIndicator, { type AgentTabStatus } from "./AgentTabStatusIndicator";

export default function AgentTabButton({
  label,
  status,
  active,
  onClick,
}: {
  label: string;
  status: AgentTabStatus;
  active: boolean;
  onClick: () => void;
}) {
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
        <button
          type="button"
          onClick={onClick}
          aria-label={`${label}, ${status.label}`}
          aria-current={active ? "page" : undefined}
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-1 text-xs ${
            active
              ? "border-kumo-brand text-kumo-default"
              : "border-transparent text-kumo-subtle hover:text-kumo-default"
          }`}
        />
      )}
    >
      <AgentTabStatusIndicator status={status} />
      <span>{label}</span>
    </Tooltip>
  );
}
