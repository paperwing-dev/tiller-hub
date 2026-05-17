/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReviewerChat from "../ReviewerChat";

const mocks = vi.hoisted(() => ({
  agentsByName: new Map<string, Record<string, unknown>>(),
  sendMessage: vi.fn(),
  useAgent: vi.fn(),
  useAgentChat: vi.fn(),
}));

vi.mock("agents/react", () => ({
  useAgent: mocks.useAgent,
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: mocks.useAgentChat,
}));

describe("ReviewerChat", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    if (!HTMLElement.prototype.scrollTo) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
      });
    }

    mocks.agentsByName.clear();
    mocks.sendMessage.mockReset();
    mocks.useAgent.mockReset();
    mocks.useAgentChat.mockReset();
    mocks.useAgent.mockImplementation(
      (options: { agent: string; name: string }) => {
        const key = `${options.agent}:${options.name}`;
        let agent = mocks.agentsByName.get(key);
        if (!agent) {
          agent = {
            identified: true,
            agent: options.agent,
            name: options.name,
            _url: `http://localhost/agents/${encodeURIComponent(key)}`,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            send: vi.fn(),
          };
          mocks.agentsByName.set(key, agent);
        }
        return agent;
      },
    );
    mocks.useAgentChat.mockImplementation(() => ({
      messages: [] satisfies UIMessage[],
      sendMessage: mocks.sendMessage,
      status: "ready",
      error: null,
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    root = null;
  });

  it("does not rerender agent hooks while typing in the reviewer box", async () => {
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          threadId="reviewer-thread-1"
          reviewerModel="@cf/nvidia/nemotron-3-120b-a12b"
          onForward={vi.fn()}
        />,
      );
    });

    const initialAgentOptions = mocks.useAgent.mock.calls.at(-1)?.[0];
    const initialChatOptions = mocks.useAgentChat.mock.calls.at(-1)?.[0];
    const initialChatCallCount = mocks.useAgentChat.mock.calls.length;
    const textarea = container.querySelector("textarea");

    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

    await act(async () => {
      setTextareaValue(
        textarea as HTMLTextAreaElement,
        "Please review the risky parts.",
      );
    });

    expect(mocks.useAgentChat.mock.calls.length).toBe(initialChatCallCount);
    expect(mocks.useAgent.mock.calls.at(-1)?.[0]).toBe(initialAgentOptions);
    expect(mocks.useAgentChat.mock.calls.at(-1)?.[0]).toBe(initialChatOptions);
  });
});

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
