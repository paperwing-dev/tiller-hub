import React from "react";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";

export default function SkillAutomationToggle({
  value,
  onChange,
  ariaLabel,
  manualTooltip,
  autoTooltip,
  disabled = false,
}: {
  value: "auto" | "manual";
  onChange: (mode: "auto" | "manual") => void;
  ariaLabel: string;
  manualTooltip: string;
  autoTooltip: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-2 text-[10px]">
      <Tooltip
        content={manualTooltip}
        side="top"
        align="end"
        render={(
          <span
            data-selected={value === "manual" ? "true" : "false"}
            className={`tiller-skill-automation-label cursor-pointer ${value === "manual" ? "font-semibold" : "font-normal"}`}
          />
        )}
      >
        Manual
      </Tooltip>
      <Switch
        size="sm"
        className="tiller-skill-automation-switch"
        checked={value === "auto"}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? "auto" : "manual")}
        aria-label={ariaLabel}
      />
      <Tooltip
        content={autoTooltip}
        side="top"
        align="end"
        render={(
          <span
            data-selected={value === "auto" ? "true" : "false"}
            className={`tiller-skill-automation-label cursor-pointer ${value === "auto" ? "font-semibold" : "font-normal"}`}
          />
        )}
      >
        Auto
      </Tooltip>
    </div>
  );
}
