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
      <Tooltip content={manualTooltip} side="top" align="end" render={<span className={`cursor-pointer ${value === "manual" ? "font-semibold text-kumo-default" : "text-kumo-subtle"}`} />}>
        Manual
      </Tooltip>
      <Switch
        size="sm"
        checked={value === "auto"}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? "auto" : "manual")}
        aria-label={ariaLabel}
      />
      <Tooltip content={autoTooltip} side="top" align="end" render={<span className={`cursor-pointer ${value === "auto" ? "font-semibold text-kumo-default" : "text-kumo-subtle"}`} />}>
        Auto
      </Tooltip>
    </div>
  );
}
