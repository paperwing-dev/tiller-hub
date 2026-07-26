import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionStatus } from "../api";
import ConnectionsBadge, { HostConnectionDetails } from "../ConnectionsBadge";

vi.mock("../api", () => ({
  fetchExecutionStatus: vi.fn(),
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
  });

  it("shows the machine chip when machine status is requested", () => {
    const html = renderToStaticMarkup(
      <ConnectionsBadge
        hubUrl="https://hub.example.com"
        hubConnected={true}
        hostRefreshNonce={0}
        showHost={true}
      />,
    );

    expect(html).toContain("Hub");
    expect(html).toContain("Machine");
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
