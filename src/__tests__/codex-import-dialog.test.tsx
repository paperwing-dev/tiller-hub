/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  seedOpenAIAuth: vi.fn(),
}));

vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  seedOpenAIAuth: mocks.seedOpenAIAuth,
}));

import { CodexImportDialog } from "../SettingsPage";

describe("CodexImportDialog", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeAll(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("imports only Codex subscription tokens through the owner-authenticated Hub", async () => {
    const hubUrl = "https://fresh.preview.workers.dev";
    mocks.seedOpenAIAuth.mockResolvedValue({ authenticated: true });
    const onImported = vi.fn().mockResolvedValue(undefined);
    const file = new File(["auth"], "auth.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: vi.fn().mockResolvedValue(JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: " access-token ",
          refresh_token: " refresh-token ",
          id_token: " id-token ",
          account_id: "must-not-be-uploaded",
        },
        unknown: "must-not-be-uploaded",
      })),
    });

    render(
      <CodexImportDialog
        hubUrl={hubUrl}
        onClose={() => undefined}
        onImported={onImported}
      />,
    );

    fireEvent.change(screen.getByLabelText("Codex auth file"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(mocks.seedOpenAIAuth).toHaveBeenCalledWith(hubUrl, {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
    }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(screen.getByText(
      "Codex subscription imported into fresh.preview.workers.dev. Settings is up to date.",
    )).toBeInTheDocument();
  });

  it("rejects non-subscription auth files without uploading them", async () => {
    const file = new File(["auth"], "auth.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: vi.fn().mockResolvedValue(JSON.stringify({
        auth_mode: "apikey",
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      })),
    });

    render(
      <CodexImportDialog
        hubUrl="https://fresh.preview.workers.dev"
        onClose={() => undefined}
        onImported={async () => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("Codex auth file"), {
      target: { files: [file] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Run codex login with a ChatGPT subscription, then select its auth.json file.",
    );
    expect(mocks.seedOpenAIAuth).not.toHaveBeenCalled();
  });
});
