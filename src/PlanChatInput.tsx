import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Textarea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import type { AgentSkillDefinition } from "./api";

interface PlanChatInputProps {
  disabled?: boolean;
  busy?: boolean;
  placeholder: string;
  busyPlaceholder?: string;
  optimisticClear?: boolean;
  draftStorageKey?: string;
  // Return (or resolve) false to indicate the send failed — the draft is
  // preserved in the composer instead of being cleared.
  onSend: (message: string) => void | boolean | Promise<void | boolean>;
  skills?: AgentSkillDefinition[];
  onInvokeSkill?: (skill: AgentSkillDefinition) => void | boolean | Promise<void | boolean>;
  compact?: boolean;
  showSkillTrigger?: boolean;
  trailingControl?: React.ReactNode;
}

export default function PlanChatInput({
  disabled = false,
  busy = false,
  placeholder,
  busyPlaceholder,
  optimisticClear = false,
  draftStorageKey,
  onSend,
  skills = [],
  onInvokeSkill,
  compact = false,
  showSkillTrigger = false,
  trailingControl,
}: PlanChatInputProps) {
  const [input, setInput] = useState(() => readStoredDraft(draftStorageKey));
  const [pending, setPending] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const skillPickerId = useId();
  const commandMode = Boolean(onInvokeSkill) && input.startsWith("/") && !/\s/.test(input);
  const commandQuery = commandMode ? input.slice(1).toLowerCase() : "";
  const skillPickerVisible = Boolean(onInvokeSkill) && (commandMode || skillPickerOpen);
  const matchingSkills = skillPickerVisible && !disabled
    ? skills.filter((skill) => skill.command.toLowerCase().startsWith(commandQuery))
    : [];
  const skillControlVisible = showSkillTrigger && Boolean(onInvokeSkill);
  const skillControlBusy = disabled || pending;
  const skillControlDisabled = skillControlBusy || skills.length === 0;
  const skillControlTitle = skillControlBusy
    ? "Available when this agent is idle."
    : skills.length === 0
      ? "No skills available."
      : "Run a skill";

  const updateInput = useCallback((value: string) => {
    setInput(value);
    writeStoredDraft(draftStorageKey, value);
  }, [draftStorageKey]);

  useEffect(() => {
    if (!skillPickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setSkillPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [skillPickerOpen]);

  useEffect(() => {
    if (disabled) setSkillPickerOpen(false);
  }, [disabled]);

  const invokeSkill = useCallback(async (skill: AgentSkillDefinition) => {
    if (!onInvokeSkill || disabled || pending) return;
    setPending(true);
    try {
      const result = await onInvokeSkill(skill);
      if (result !== false && commandMode) updateInput("");
      if (result !== false) setSkillPickerOpen(false);
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }, [commandMode, disabled, onInvokeSkill, pending, updateInput]);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || disabled || pending) return;
    if (commandMode && matchingSkills.length > 0) {
      const exact = matchingSkills.find((skill) => skill.command.toLowerCase() === commandQuery);
      await invokeSkill(exact ?? matchingSkills[0]!);
      return;
    }
    if (busy) return;
    setPending(true);
    if (optimisticClear) setInput("");
    try {
      const result = await onSend(message);
      if (result === false && optimisticClear) setInput(message);
      else if (result !== false) updateInput("");
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }, [busy, commandMode, commandQuery, disabled, input, invokeSkill, matchingSkills, onSend, optimisticClear, pending, updateInput]);

  const skillReady = commandMode && matchingSkills.length > 0;
  const canSubmit = Boolean(input.trim())
    && (!commandMode || skillReady)
    && (!busy || skillReady);

  return (
    <div
      ref={composerRef}
      className={`tiller-skill-composer relative border-t border-kumo-line bg-kumo-base ${compact ? "h-full px-3 py-2" : "px-4 py-3"}`}
    >
      {matchingSkills.length > 0 && (
        <LayerCard
          id={skillPickerId}
          className="tiller-dropdown-panel absolute bottom-full left-4 right-4 z-10 mb-1 max-h-64 overflow-y-auto shadow-xl"
        >
          {matchingSkills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => void invokeSkill(skill)}
              disabled={pending}
              className="flex w-full items-center justify-between border-b border-kumo-line px-3 py-2 text-left last:border-b-0 hover:bg-kumo-tint disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block font-mono text-[13px] font-semibold text-kumo-info">/{skill.command}</span>
                <span className="block truncate text-xs text-kumo-subtle">{skill.description}</span>
              </span>
              <Badge variant="outline" className="ml-3 shrink-0 text-[11px]">
                Launches {skill.agents.length} reviewer{skill.agents.length === 1 ? "" : "s"}
                <span className="sr-only"> · {skill.agents.length} agents</span>
              </Badge>
            </button>
          ))}
        </LayerCard>
      )}
      <div className={compact ? "flex h-full w-full items-end gap-1" : "mx-auto flex max-w-3xl items-end gap-2"}>
        <Textarea
          ref={inputRef}
          aria-label="Message"
          value={input}
          onChange={(event) => {
            updateInput(event.target.value);
            if (!event.target.value.startsWith("/")) setSkillPickerOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && skillPickerVisible) {
              event.preventDefault();
              setSkillPickerOpen(false);
              if (commandMode) updateInput("");
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder={busy ? busyPlaceholder ?? placeholder : placeholder}
          rows={1}
          className={`flex-1 resize-none text-[13px] ${compact ? "h-full max-h-full min-h-10" : ""}`}
          disabled={disabled || pending}
        />
        {skillControlVisible && (
          <Tooltip
            content={skillControlTitle}
            side="top"
            delay={250}
            render={<span className="inline-flex shrink-0" />}
          >
            <button
              type="button"
              className="tiller-skill-trigger"
              onClick={() => {
                if (skillPickerVisible) {
                  setSkillPickerOpen(false);
                  if (commandMode) updateInput("");
                } else {
                  setSkillPickerOpen(true);
                }
                inputRef.current?.focus();
              }}
              disabled={skillControlDisabled}
              aria-label="Run a skill"
              aria-expanded={skillPickerVisible && matchingSkills.length > 0}
              aria-controls={skillPickerVisible && matchingSkills.length > 0 ? skillPickerId : undefined}
            >
              <span className="tiller-skill-trigger-label">Skills</span>
              <span className="font-mono" aria-hidden="true">/</span>
            </button>
          </Tooltip>
        )}
        {compact ? (
          <button
            type="button"
            className="tiller-composer-send-button tiller-reviewer-send-button--disabled tiller-square-button tiller-square-button--icon tiller-square-button--primary"
            onClick={() => void handleSend()}
            disabled={disabled || pending || !canSubmit}
            aria-label="Send"
            title="Send"
          >
            <PaperPlaneTiltIcon className="size-3.5" weight="regular" aria-hidden="true" />
          </button>
        ) : (
          <Button
            variant="primary"
            className="!h-10 text-[13px]"
            onClick={() => void handleSend()}
            disabled={disabled || pending || !canSubmit}
          >
            Send
          </Button>
        )}
        {trailingControl}
      </div>
    </div>
  );
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredDraft(storageKey: string | undefined): string {
  if (!storageKey) return "";
  try {
    return getSessionStorage()?.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function writeStoredDraft(storageKey: string | undefined, value: string): void {
  if (!storageKey) return;
  try {
    const storage = getSessionStorage();
    if (!storage) return;
    if (value) storage.setItem(storageKey, value);
    else storage.removeItem(storageKey);
  } catch {
    // Draft persistence remains best effort in storage-restricted contexts.
  }
}
