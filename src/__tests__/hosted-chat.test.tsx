import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import HostedChatTranscript from "../HostedChatTranscript";
import {
  getHostedToolOutputFingerprint,
  listHostedChatMessages,
} from "../hosted-chat";

const baseMessages: UIMessage[] = [
  {
    id: "user-1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Plan this change.",
      },
    ],
  } as UIMessage,
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-read_file",
        toolCallId: "call-read",
        state: "output-error",
        input: { path: "/missing.txt" },
        errorText: "File not found at /missing.txt",
      },
      {
        type: "text",
        text: "I could not read that file.",
      },
    ],
  } as UIMessage,
  {
    id: "assistant-2",
    role: "assistant",
    parts: [
      {
        type: "tool-save_artifact",
        toolCallId: "call-save",
        state: "output-available",
        input: {},
        output: "Saved artifact artifact-123 :: Draft :: Summary",
      },
    ],
  } as UIMessage,
];

describe("hosted chat helpers", () => {
  it("maps UI messages into hosted chat messages with inline tool errors", () => {
    const rendered = listHostedChatMessages(baseMessages);

    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toMatchObject({
      role: "assistant",
      content: "I could not read that file.",
    });
    expect(rendered[1]?.toolCalls).toEqual([
      {
        id: "call-read",
        name: "read_file",
        error: "File not found at /missing.txt",
        pending: false,
      },
    ]);
  });

  it("builds stable fingerprints from successful tool outputs", () => {
    expect(getHostedToolOutputFingerprint(baseMessages, "save_artifact")).toBe(
      "call-save:Saved artifact artifact-123 :: Draft :: Summary",
    );
  });
});

describe("HostedChatTranscript", () => {
  it("renders tool failure details from hosted chat messages", () => {
    const html = renderToString(
      <HostedChatTranscript
        messages={baseMessages}
        emptyState="Nothing here yet."
        status="ready"
      />,
    );

    expect(html).toContain("read_file");
    expect(html).toContain("failed");
    expect(html).toContain("File not found at /missing.txt");
    expect(html).toContain("I could not read that file.");
  });

  it("renders the shared empty state", () => {
    const html = renderToString(
      <HostedChatTranscript
        messages={[]}
        emptyState="Nothing here yet."
        status="ready"
      />,
    );

    expect(html).toContain("Nothing here yet.");
  });
});
