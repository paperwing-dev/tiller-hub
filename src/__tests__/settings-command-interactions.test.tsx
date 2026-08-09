/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSubscriptionRow, CopyableTerminalCommand } from "../SettingsPage";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Settings terminal commands", () => {
  it("keeps a compact command disclosure beside copy while hiding the full command by default", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const command = "npx -y @paperwing-dev/tiller@latest auth connect codex";

    render(
      <CopyableTerminalCommand
        command={command}
        label="Codex setup"
        buttonLabel="Copy setup command"
        viewLabel="View command"
        helper="No install needed."
      />,
    );

    const copyButton = screen.getByRole("button", {
      name: "Copy Codex setup command",
    });
    const viewButton = screen.getByRole("button", { name: "View command" });
    expect(copyButton.parentElement).toBe(viewButton.parentElement);
    expect(viewButton).not.toHaveTextContent("View command");
    expect(screen.getByText(command)).not.toBeVisible();

    fireEvent.click(viewButton);
    expect(screen.getByText(command)).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide command" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    expect(screen.getByRole("button", { name: "Copy Codex setup command" })).toHaveTextContent("Copied");
  });

  it("reveals Claude's manual token instructions only when requested", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ClaudeSubscriptionRow
        status={{
          hasClaudeSubscription: false,
          claudeBillingMode: "subscription",
        }}
        canonicalHubUrl="https://hub.example.com"
        onSave={onSave}
      />,
    );

    expect(screen.queryByText("claude setup-token", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter token manually" }));
    expect(screen.getByText("claude setup-token", { exact: false })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Paste Claude subscription token"), {
      target: { value: "claude-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
      }),
    );
  });
});
