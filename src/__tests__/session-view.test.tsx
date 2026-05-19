import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SessionView from "../SessionView";

vi.mock("../TerminalView", () => ({
  default: React.forwardRef(function MockTerminalView() {
    return React.createElement("div", null, "terminal");
  }),
}));

vi.mock("../PermissionBanner", () => ({
  default: () => null,
}));

vi.mock("../StatusBar", () => ({
  default: () => null,
}));

vi.mock("../VoiceAgent", () => ({
  default: () => null,
}));

vi.mock("@cloudflare/voice/react", () => ({
  useVoiceAgent: () => ({
    status: "idle",
    transcript: [],
    interimTranscript: "",
    audioLevel: 0,
    isMuted: false,
    connected: false,
    error: null,
    metrics: null,
    startCall: vi.fn(),
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    sendJSON: vi.fn(),
    lastCustomMessage: null,
  }),
}));

function makeSession() {
  return {
    id: "session-1",
    tag: "demo-env",
    machine_id: null,
    metadata: "{}",
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 1,
    ended_at: null,
    created_at: "2026-04-10T00:00:00.000Z",
    updated_at: "2026-04-10T00:00:00.000Z",
  } as const;
}

describe("SessionView", () => {
  it("shows a Stop control for interactive env-backed sessions", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "running",
          harness: "claude-code",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).toContain("Stop");
  });

  it("still shows Stop while the env metadata is catching up from starting", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "starting",
          harness: "claude-code",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).toContain("Stop");
  });

  it("still shows Stop when the session activity bit lags behind a running env", () => {
    const html = renderToString(
      <SessionView
        session={{
          ...makeSession(),
          active: 0,
        }}
        env={{
          slug: "demo-env",
          status: "running",
          harness: "claude-code",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).toContain("Stop");
  });

  it("hides the Stop control once the env is saving changes", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "saving",
          harness: "claude-code",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).not.toContain(">Stop<");
  });
});
