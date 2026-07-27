/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../api";

const mocks = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
}));

vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  fetchSetupStatus: mocks.fetchSetupStatus,
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

  it("copies an exact Hub command and refreshes when the import appears", async () => {
    const hubUrl = "https://fresh.preview.workers.dev";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.fetchSetupStatus.mockResolvedValue({
      hasChatGPTAuth: true,
      chatgptAuthStatus: "connected",
    } satisfies Partial<SetupStatus>);
    const onImported = vi.fn().mockResolvedValue(undefined);

    render(
      <CodexImportDialog
        hubUrl={hubUrl}
        onClose={() => undefined}
        onImported={onImported}
      />,
    );

    const command = `npx --yes @paperwing-dev/tiller@latest auth import codex --hub-url ${hubUrl}`;
    expect(screen.getByText(command)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(screen.getByText(
      "Codex subscription imported into fresh.preview.workers.dev. Settings is up to date.",
    )).toBeInTheDocument();
  });
});
