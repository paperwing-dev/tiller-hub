import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_MCP_PROXY_TOKEN_HEADER,
  proxyCloudflareMcpRequest,
  type CloudflareMcpProxyHub,
} from "../cloudflare-mcp";

function createHub(): CloudflareMcpProxyHub & {
  getValidCloudflareMcpAccessToken: ReturnType<typeof vi.fn>;
  recordCloudflareMcpAuditEvent: ReturnType<typeof vi.fn>;
} {
  return {
    validateCloudflareMcpProxyToken: vi.fn().mockResolvedValue({
      ok: true,
      repoId: "repo-1",
      envSlug: "env-1",
      serverId: "tiller_cloudflare_api",
    }),
    getValidCloudflareMcpAccessToken: vi.fn()
      .mockResolvedValueOnce({ accessToken: "token-1" })
      .mockResolvedValueOnce({ accessToken: "token-2" }),
    recordCloudflareMcpAuditEvent: vi.fn(),
  } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare MCP proxy", () => {
  it("retries a safe single JSON-RPC POST after a pre-body 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": "Bearer token=secret",
          "Set-Cookie": "secret=value",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "secret=value",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
        Authorization: "Bearer inbound-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }), hub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0][1].headers as Headers;
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(firstHeaders.get("Authorization")).toBe("Bearer token-1");
    expect(secondHeaders.get("Authorization")).toBe("Bearer token-2");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(hub.getValidCloudflareMcpAccessToken).toHaveBeenNthCalledWith(2, "repo-1", { forceRefresh: true });
    expect(hub.recordCloudflareMcpAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      jsonRpcMethod: "initialize",
      responseStatus: 200,
      errorCode: null,
    }));
  });

  it("does not retry tools/call after a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "zones" } }),
    }), hub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "call-1",
      error: {
        data: { code: "cloudflare_retry_not_safe" },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hub.getValidCloudflareMcpAccessToken).toHaveBeenCalledTimes(2);
    expect(hub.getValidCloudflareMcpAccessToken).toHaveBeenNthCalledWith(2, "repo-1", { forceRefresh: true });
    expect(hub.recordCloudflareMcpAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      jsonRpcMethod: "tools/call",
      errorCode: "cloudflare_retry_not_safe",
    }));
  });

  it("forwards JSON-RPC notifications once without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    }), hub);

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hub.getValidCloudflareMcpAccessToken).toHaveBeenCalledTimes(1);
    expect(hub.recordCloudflareMcpAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      jsonRpcMethod: "notifications/initialized",
      responseStatus: 202,
      errorCode: null,
    }));
  });

  it("returns JSON-RPC errors for parseable single requests with an id", async () => {
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bad-method" }),
    }), hub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "bad-method",
      error: {
        data: { code: "cloudflare_upstream_error" },
      },
    });
  });

  it("rejects invalid JSON-RPC envelopes before fetching upstream tokens", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "list-1", method: "tools/list" }),
    }), hub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "list-1",
      error: {
        data: { code: "cloudflare_upstream_error" },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hub.getValidCloudflareMcpAccessToken).not.toHaveBeenCalled();
    expect(hub.recordCloudflareMcpAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      jsonRpcMethod: null,
      errorCode: "cloudflare_upstream_error",
    }));
  });

  it("returns sanitized HTTP errors for invalid JSON-RPC ids", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: { nested: true }, method: "tools/list" }),
    }), hub);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "cloudflare_upstream_error",
      error: "JSON-RPC request id is invalid.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hub.getValidCloudflareMcpAccessToken).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON-RPC params before retry classification", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: "bad" }),
    }), hub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 3,
      error: {
        data: { code: "cloudflare_upstream_error" },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hub.getValidCloudflareMcpAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes before DELETE cleanup and does not retry after a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const hub = createHub();

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "DELETE",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "MCP-Session-Id": "session-1",
      },
    }), hub);

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hub.getValidCloudflareMcpAccessToken).toHaveBeenCalledWith("repo-1", { forceRefresh: true });
    expect(hub.recordCloudflareMcpAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      responseStatus: 401,
      errorCode: "cloudflare_reauth_required",
    }));
  });

  it("maps token lookup network failures to sanitized upstream errors", async () => {
    const hub = createHub();
    hub.getValidCloudflareMcpAccessToken
      .mockReset()
      .mockRejectedValueOnce(new Error("network unavailable"));

    const response = await proxyCloudflareMcpRequest(new Request("https://hub.example.com/api/mcp/cloudflare", {
      method: "POST",
      headers: {
        [CLOUDFLARE_MCP_PROXY_TOKEN_HEADER]: "proxy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "list-1", method: "tools/list" }),
    }), hub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "list-1",
      error: {
        data: { code: "cloudflare_upstream_error" },
      },
    });
    expect(hub.recordCloudflareMcpAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      jsonRpcMethod: "tools/list",
      errorCode: "cloudflare_upstream_error",
    }));
  });
});
