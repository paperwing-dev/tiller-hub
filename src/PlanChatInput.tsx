import React, { useCallback, useRef, useState } from "react";

interface PlanChatInputProps {
  disabled?: boolean;
  placeholder: string;
  onSend: (message: string) => void;
}

export default function PlanChatInput({
  disabled = false,
  placeholder,
  onSend,
}: PlanChatInputProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const message = input.trim();
    if (!message || disabled) return;
    onSend(message);
    setInput("");
    inputRef.current?.focus();
  }, [disabled, input, onSend]);

  return (
    <div className="border-t border-[#d0d7de] bg-white px-4 py-3">
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-[#d0d7de] px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#0969da]"
          disabled={disabled}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white hover:bg-[#0860c4] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
