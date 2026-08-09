/**
 * @vitest-environment jsdom
 */
import React, { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  approveAuthConnect: vi.fn(),
  fetchAuthConnectStatus: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  approveAuthConnect: apiMocks.approveAuthConnect,
  fetchAuthConnectStatus: apiMocks.fetchAuthConnectStatus,
}));

import {
  AuthConnectPanel,
  parseAuthConnectIntent,
  type AuthConnectIntent,
} from "../SettingsPage";

function intent(state: string): Exclude<AuthConnectIntent, null> {
  return {
    kind: "request",
    request: {
      port: 1455,
      state,
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) },
      providers: ["codex"],
    },
  };
}

describe("Settings subscription connection panel", () => {
  beforeEach(() => {
    apiMocks.approveAuthConnect.mockReset();
    apiMocks.fetchAuthConnectStatus.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("parses the CLI handoff only when all Settings parameters are valid", () => {
    const publicKey = { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) };
    const encodedKey = btoa(JSON.stringify(publicKey)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(parseAuthConnectIntent(
      `?auth_connect=1&port=1455&state=state-1&key=${encodedKey}&providers=codex`,
    )).toEqual({
      kind: "request",
      request: { port: 1455, state: "state-1", publicKeyJwk: publicKey, providers: ["codex"] },
    });
    expect(parseAuthConnectIntent("?auth_connect=1&port=0")).toEqual({ kind: "invalid" });
    expect(parseAuthConnectIntent("?unrelated=1")).toBeNull();
  });

  it("stays in Settings until the Hub confirms the subscription was saved", async () => {
    apiMocks.approveAuthConnect.mockResolvedValue({ envelope: "encrypted-envelope", connectionId: "connection-id-1234" });
    apiMocks.fetchAuthConnectStatus.mockResolvedValue({
      status: "success",
      providers: { codex: "success" },
      error: null,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const onRefresh = vi.fn(async () => undefined);

    render(
      <StrictMode>
        <AuthConnectPanel intent={intent("settings-success-state")} onRefresh={onRefresh} />
      </StrictMode>,
    );

    expect(screen.getByText("Subscription sign-in")).toBeInTheDocument();
    expect(screen.getByText("Owner approval")).toBeInTheDocument();
    expect(screen.getByText("Save in Tiller")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Codex connected")).toBeInTheDocument());
    expect(screen.getByText(/saved in Tiller Settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/Return to your terminal/i)).not.toBeInTheDocument();
    expect(apiMocks.approveAuthConnect).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:1455/auth-connect-callback",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ envelope: "encrypted-envelope" }) }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the one-time code in Settings when the local CLI cannot be reached", async () => {
    apiMocks.approveAuthConnect.mockResolvedValue({ envelope: "manual-encrypted-envelope", connectionId: "connection-id-5678" });
    apiMocks.fetchAuthConnectStatus.mockImplementation(() => new Promise(() => undefined));
    vi.mocked(fetch).mockRejectedValue(new TypeError("local callback unavailable"));

    render(<AuthConnectPanel intent={intent("settings-manual-state")} onRefresh={async () => undefined} />);

    await waitFor(() => expect(screen.getByText("Connection code ready")).toBeInTheDocument());
    expect(screen.getByText("manual-encrypted-envelope")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy connection code" })).toBeInTheDocument();
    expect(screen.getByText(/Settings will confirm the result here/i)).toBeInTheDocument();
  });

  it("shows the sanitized Hub failure in Settings", async () => {
    apiMocks.approveAuthConnect.mockResolvedValue({ envelope: "error-envelope", connectionId: "connection-id-9012" });
    apiMocks.fetchAuthConnectStatus.mockResolvedValue({
      status: "error",
      providers: { codex: "error" },
      error: "Codex subscription authentication is temporarily unavailable. Retry the connection.",
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    render(<AuthConnectPanel intent={intent("settings-error-state")} onRefresh={async () => undefined} />);

    await waitFor(() => expect(screen.getByText("Codex could not be connected")).toBeInTheDocument());
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByText("Action needed")).toBeInTheDocument();
  });
});
