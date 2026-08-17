/**
 * @vitest-environment jsdom
 */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTION_STATUS_CHANGED_EVENT,
  type ExecutionStatus,
} from "../api";
import ConnectionsBadge, {
  describeHostStatus,
  HostConnectionDetails,
} from "../ConnectionsBadge";

const apiMocks = vi.hoisted(() => ({
  fetchExecutionStatus: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  fetchExecutionStatus: apiMocks.fetchExecutionStatus,
}));

const readyExecutionStatus: ExecutionStatus = {
  selected: { target: "host", machineId: "machine-1234567890" },
  selectedHost: {
    state: "ready",
    machineId: "machine-1234567890",
    displayName: "studio-mac",
  },
  candidate: {
    state: "ready",
    machineId: "tiller-host-1234567890",
    displayName: "studio-mac",
  },
  executionReady: true,
};

describe("ConnectionsBadge", () => {
  afterEach(() => {
    cleanup();
    apiMocks.fetchExecutionStatus.mockReset();
  });

  it("can hide the machine chip", () => {
    const html = renderToStaticMarkup(
      <ConnectionsBadge
        hubUrl="https://hub.example.com"
        hubConnected={true}
        hostRefreshNonce={0}
        showHost={false}
      />,
    );

    expect(html).toContain("Hub");
    expect(html).not.toContain("Machine");
    expect(html).not.toContain("title=");
  });

  it("waits for the selected backend before showing the machine chip", () => {
    const html = renderToStaticMarkup(
      <ConnectionsBadge
        hubUrl="https://hub.example.com"
        hubConnected={true}
        hostRefreshNonce={0}
        showHost={true}
      />,
    );

    expect(html).toContain("Hub");
    expect(html).not.toContain("Machine");
  });

  it("hides stale machine status immediately after selecting Cloudflare", async () => {
    apiMocks.fetchExecutionStatus.mockResolvedValue(readyExecutionStatus);
    render(
      <ConnectionsBadge
        hubUrl="https://hub.example.com"
        hubConnected={true}
        hostRefreshNonce={0}
        showHost={true}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAccessibleName(
        "Hub: connected · Machine: connected and ready",
      );
    });

    const cloudflareStatus: ExecutionStatus = {
      ...readyExecutionStatus,
      selected: { target: "cf" },
      selectedHost: null,
      executionReady: true,
    };
    act(() => {
      window.dispatchEvent(new CustomEvent(EXECUTION_STATUS_CHANGED_EVENT, {
        detail: cloudflareStatus,
      }));
    });

    const badge = screen.getByRole("button", { name: "Hub: connected" });
    expect(badge).not.toHaveTextContent("Machine");

    fireEvent.mouseEnter(badge);
    const popover = screen.getByText("Connected").closest(".absolute");
    expect(popover).toHaveClass("w-max", "min-w-36");
    expect(popover).not.toHaveClass("w-72");
    expect(screen.getByText("Connected").parentElement?.parentElement)
      .not.toHaveClass("border-b");
    expect(screen.queryByText("Your machine")).not.toBeInTheDocument();
  });

  it("identifies a competing incompatible machine when the selected machine is offline", () => {
    const status = describeHostStatus({
      selected: { target: "host", machineId: "selected-machine" },
      selectedHost: {
        state: "offline",
        machineId: "selected-machine",
        displayName: "selected-machine",
      },
      candidate: {
        state: "incompatible",
        machineId: "competing-machine",
        displayName: "old-laptop",
        code: "runtime_image",
      },
      executionReady: false,
    }, null);

    expect(status).toMatchObject({
      title: "Machine: selected, offline",
      detail: "The selected execution machine is offline. old-laptop is connected but needs an update (runtime image).",
    });
  });

  it("omits runtime capabilities and subscription auth details from host details", () => {
    const html = renderToStaticMarkup(
      <HostConnectionDetails
        execution={readyExecutionStatus}
        hostError={null}
      />,
    );

    expect(html).toContain("Machine");
    expect(html).toContain("Name");
    expect(html).toContain("studio-mac");
    expect(html).not.toContain("Protocol");
    expect(html).not.toContain("tiller-sandbox");
    expect(html).not.toContain("Auth");
    expect(html).not.toContain("Codex");
    expect(html).not.toContain("Claude");
  });
});
