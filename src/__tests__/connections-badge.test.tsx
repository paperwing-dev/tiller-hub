import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostStatus } from "../api";
import ConnectionsBadge, { HostConnectionDetails } from "../ConnectionsBadge";

vi.mock("../api", () => ({
  fetchHostStatus: vi.fn(),
}));

const readyHostStatus: HostStatus = {
  registered: true,
  connected: true,
  gatewayConfigured: true,
  gatewayAvailable: true,
  state: "gateway-available",
  machine: {
    machineId: "tiller-host-1234567890",
    connectedAt: "2026-05-29T00:00:00.000Z",
    gatewayUrl: "https://gateway.example.com",
    codexSubscription: true,
    claudeSubscription: true,
  },
};

describe("ConnectionsBadge", () => {
  it("hides the host chip in Hosted Tiller mode", () => {
    const html = renderToStaticMarkup(
      <ConnectionsBadge
        hubUrl="https://hub.example.com"
        hubConnected={true}
        hostRefreshNonce={0}
        showHost={false}
      />,
    );

    expect(html).toContain("Hub");
    expect(html).not.toContain("Host");
  });

  it("shows the host chip when Self Host is active", () => {
    const html = renderToStaticMarkup(
      <ConnectionsBadge
        hubUrl="https://hub.example.com"
        hubConnected={true}
        hostRefreshNonce={0}
        showHost={true}
      />,
    );

    expect(html).toContain("Hub");
    expect(html).toContain("Host");
  });

  it("omits gateway URLs and subscription auth details from host details", () => {
    const html = renderToStaticMarkup(
      <HostConnectionDetails
        hostStatus={readyHostStatus}
        hostError={null}
        now={Date.parse("2026-05-29T00:00:30.000Z")}
      />,
    );

    expect(html).toContain("Machine");
    expect(html).toContain("Since");
    expect(html).not.toContain("Gateway");
    expect(html).not.toContain("https://gateway.example.com");
    expect(html).not.toContain("Auth");
    expect(html).not.toContain("Codex");
    expect(html).not.toContain("Claude");
  });
});
