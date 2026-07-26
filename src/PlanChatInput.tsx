import React, { useCallback, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Textarea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { AgentSkillDefinition } from "./api";

interface PlanChatInputProps {
  disabled?: boolean;
  placeholder: string;
  // Return (or resolve) false to indicate the send failed — the draft is
  // preserved in the composer instead of being cleared.
  onSend: (message: string) => void | boolean | Promise<void | boolean>;
  skills?: AgentSkillDefinition[];
  onInvokeSkill?: (skill: AgentSkillDefinition) => void | boolean | Promise<void | boolean>;
}

export default function PlanChatInput({
  disabled = false,
  placeholder,
  onSend,
  skills = [],
  onInvokeSkill,
}: PlanChatInputProps) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commandMode = Boolean(onInvokeSkill) && input.startsWith("/") && !/\s/.test(input);
  const commandQuery = commandMode ? input.slice(1).toLowerCase() : "";
  const matchingSkills = commandMode && !disabled
    ? skills.filter((skill) => skill.command.toLowerCase().startsWith(commandQuery))
    : [];

  const invokeSkill = useCallback(async (skill: AgentSkillDefinition) => {
    if (!onInvokeSkill || disabled || pending) return;
    setPending(true);
    try {
      const result = await onInvokeSkill(skill);
      if (result !== false) setInput("");
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }, [disabled, onInvokeSkill, pending]);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || disabled || pending) return;
    if (commandMode && matchingSkills.length > 0) {
      const exact = matchingSkills.find((skill) => skill.command.toLowerCase() === commandQuery);
      await invokeSkill(exact ?? matchingSkills[0]!);
      return;
    }
    setPending(true);
    try {
      const result = await onSend(message);
      if (result !== false) {
        setInput("");
      }
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }, [commandMode, commandQuery, disabled, input, invokeSkill, matchingSkills, onSend, pending]);

  const canSubmit = Boolean(input.trim()) && (!commandMode || matchingSkills.length > 0);

  return (
    <div className="relative border-t border-kumo-line bg-kumo-base px-4 py-3">
      {matchingSkills.length > 0 && (
        <LayerCard className="absolute bottom-full left-4 right-4 z-10 mb-1 max-h-64 overflow-y-auto shadow-xl">
          {matchingSkills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => void invokeSkill(skill)}
              disabled={pending}
              className="flex w-full items-center justify-between border-b border-kumo-line px-3 py-2 text-left last:border-b-0 hover:bg-kumo-tint disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block font-mono text-xs font-semibold text-kumo-info">/{skill.command}</span>
                <span className="block truncate text-[10px] text-kumo-subtle">{skill.description}</span>
              </span>
              <Badge variant="outline" className="ml-3 shrink-0 text-[10px]">
                {skill.agents.length} agent{skill.agents.length === 1 ? "" : "s"}
              </Badge>
            </button>
          ))}
        </LayerCard>
      )}
      <div className="mx-auto flex max-w-3xl gap-2">
        <Textarea
          ref={inputRef}
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="flex-1 resize-none"
          disabled={disabled || pending}
        />
        <Button
          variant="primary"
          onClick={() => void handleSend()}
          disabled={disabled || pending || !canSubmit}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
