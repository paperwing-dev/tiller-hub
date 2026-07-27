import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_TOKENS_KEY,
  OpenAIAuthBroker,
  toOpenAIImportBoundary,
  toOpenAIRuntimeAuthBoundary,
} from "../openai-auth-broker";

class MemoryKV {
  private store = new Map<string, string>();
  async get<T>(key: string, type?: "text" | "json"): Promise<T | string | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) as T : value;
  }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
}

function jwt(accountId: string, nonce: string): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
    chatgpt_account_id: accountId,
    nonce,
  })).toString("base64url")}.sig`;
}

function jwtClaims(claims: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

describe("OpenAIAuthBroker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent rejection of the same access token", async () => {
    const broker = new OpenAIAuthBroker({ ENVS_KV: new MemoryKV() } as any);
    const oldToken = jwt("acct-1", "old");
    await broker.seedForTests({ access_token: oldToken, refresh_token: "refresh-1" });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: jwt("acct-1", "new"),
        refresh_token: "refresh-2",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const rejected = await sha256(oldToken);
    const [first, second] = await Promise.all([
      broker.runtimeAuth(rejected),
      broker.runtimeAuth(rejected),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, credential: { accountId: "acct-1" } });
    expect(second).toEqual(first);
  });

  it("returns an already-rotated token for a stale rejected hash", async () => {
    const broker = new OpenAIAuthBroker({ ENVS_KV: new MemoryKV() } as any);
    const token = jwt("acct-1", "current");
    await broker.seedForTests({ access_token: token, refresh_token: "refresh-1" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await broker.runtimeAuth(await sha256(jwt("acct-1", "stale")));
    expect(result).toMatchObject({ ok: true, credential: { accessToken: token } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves credentials on transient OAuth failure", async () => {
    const broker = new OpenAIAuthBroker({ ENVS_KV: new MemoryKV() } as any);
    const token = jwt("acct-1", "old");
    await broker.seedForTests({ access_token: token, refresh_token: "refresh-1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "server_error" }),
    }));
    await expect(broker.runtimeAuth(await sha256(token))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(broker.getReadOnlyStatus()).resolves.toMatchObject({
      status: "temporarily_unavailable",
      account_id: "acct-1",
    });
  });

  it("rejects automatic account drift without committing it", async () => {
    const broker = new OpenAIAuthBroker({ ENVS_KV: new MemoryKV() } as any);
    const token = jwt("acct-1", "old");
    await broker.seedForTests({ access_token: token, refresh_token: "refresh-1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: jwt("acct-2", "new"),
        refresh_token: "refresh-2",
        expires_in: 3600,
      }),
    }));
    await expect(broker.runtimeAuth(await sha256(token))).resolves.toMatchObject({
      ok: false,
      reason: "needs_reconnect",
    });
    await expect(broker.getReadOnlyStatus()).resolves.toMatchObject({
      status: "needs_reconnect",
      account_id: "acct-1",
    });
  });

  it("allows a validated explicit re-import to replace the ChatGPT account", async () => {
    const kv = new MemoryKV();
    const broker = new OpenAIAuthBroker({ ENVS_KV: kv } as any);
    await broker.seedForTests({
      access_token: jwt("acct-1", "old"),
      refresh_token: "refresh-1",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: jwt("acct-2", "validated"),
        refresh_token: "refresh-2-rotated",
        expires_in: 3600,
      }),
    }));

    await expect(broker.import({
      access_token: jwt("acct-2", "imported"),
      refresh_token: "refresh-2",
    })).resolves.toMatchObject({
      ok: true,
      stored: { account_id: "acct-2", refresh_token: "refresh-2-rotated" },
    });
    await expect(broker.runtimeAuth()).resolves.toMatchObject({
      ok: true,
      credential: { accountId: "acct-2" },
    });
  });

  it("requires a supported, internally consistent ChatGPT account identity", async () => {
    const kv = new MemoryKV();
    const broker = new OpenAIAuthBroker({ ENVS_KV: kv } as any);
    await kv.put(OPENAI_TOKENS_KEY, JSON.stringify({
      access_token: jwtClaims({ organization_id: "org-not-an-account" }),
      refresh_token: "refresh",
      account_id: "org-not-an-account",
      expires_at: Date.now() + 3_600_000,
    }));
    await expect(broker.runtimeAuth()).resolves.toMatchObject({
      ok: false,
      reason: "needs_reconnect",
    });

    await kv.put(OPENAI_TOKENS_KEY, JSON.stringify({
      access_token: jwt("acct-access", "current"),
      id_token: jwt("acct-id", "current"),
      refresh_token: "refresh",
      account_id: "acct-id",
      expires_at: Date.now() + 3_600_000,
    }));
    await expect(broker.getReadOnlyStatus()).resolves.toMatchObject({
      authenticated: false,
      status: "needs_reconnect",
    });
  });

  it("maps invalid_grant and invalid token rotation to re-import without committing candidates", async () => {
    const kv = new MemoryKV();
    const broker = new OpenAIAuthBroker({ ENVS_KV: kv } as any);
    const oldToken = jwt("acct-1", "old");
    await broker.seedForTests({ access_token: oldToken, refresh_token: "refresh-old" });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: jwt("acct-1", "candidate"),
          refresh_token: "",
          expires_in: 3600,
        }),
      });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(broker.runtimeAuth(await sha256(oldToken))).resolves.toMatchObject({
      ok: false,
      reason: "needs_reconnect",
    });
    await expect(broker.runtimeAuth(await sha256(oldToken))).resolves.toMatchObject({
      ok: false,
      reason: "needs_reconnect",
    });
    await expect(kv.get(OPENAI_TOKENS_KEY, "json")).resolves.toMatchObject({
      access_token: oldToken,
      refresh_token: "refresh-old",
      account_id: "acct-1",
    });
  });

  it("treats OAuth throttling and network errors as transient while preserving credentials", async () => {
    const kv = new MemoryKV();
    const broker = new OpenAIAuthBroker({ ENVS_KV: kv } as any);
    const oldToken = jwt("acct-1", "old");
    await broker.seedForTests({ access_token: oldToken, refresh_token: "refresh-old" });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate_limit_exceeded" }),
      })
      .mockRejectedValueOnce(new TypeError("network unavailable"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(broker.runtimeAuth(await sha256(oldToken))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(broker.runtimeAuth(await sha256(oldToken))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(kv.get(OPENAI_TOKENS_KEY, "json")).resolves.toMatchObject({
      access_token: oldToken,
      refresh_token: "refresh-old",
    });
  });

  it("serializes refresh and import mutations through one FIFO", async () => {
    const broker = new OpenAIAuthBroker({ ENVS_KV: new MemoryKV() } as any);
    const oldToken = jwt("acct-1", "old");
    await broker.seedForTests({ access_token: oldToken, refresh_token: "refresh-old" });
    let releaseRefresh!: (value: unknown) => void;
    const firstResponse = new Promise((resolve) => { releaseRefresh = resolve; });
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: jwt("acct-2", "validated"),
          refresh_token: "refresh-2-rotated",
          expires_in: 3600,
        }),
      });
    vi.stubGlobal("fetch", fetchSpy);

    const refresh = broker.runtimeAuth(await sha256(oldToken));
    const imported = broker.import({
      access_token: jwt("acct-2", "imported"),
      refresh_token: "refresh-2",
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    releaseRefresh({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: jwt("acct-1", "refreshed"),
        refresh_token: "refresh-1-rotated",
        expires_in: 3600,
      }),
    });

    await expect(refresh).resolves.toMatchObject({ ok: true, credential: { accountId: "acct-1" } });
    await expect(imported).resolves.toMatchObject({ ok: true, stored: { account_id: "acct-2" } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(broker.runtimeAuth()).resolves.toMatchObject({ ok: true, credential: { accountId: "acct-2" } });
  });

  it("never exposes refresh tokens across the HubDO boundary", () => {
    const stored = {
      access_token: jwt("acct-1", "current"),
      refresh_token: "never-export-this",
      account_id: "acct-1",
      expires_at: Date.now() + 60_000,
    };
    const runtime = toOpenAIRuntimeAuthBoundary({
      ok: true,
      stored,
      credential: {
        accessToken: stored.access_token,
        accountId: "acct-1",
        expiresAt: new Date(stored.expires_at).toISOString(),
      },
    });
    const imported = toOpenAIImportBoundary({ ok: true, stored });
    expect(runtime).not.toHaveProperty("stored");
    expect(imported).not.toHaveProperty("stored");
    expect(JSON.stringify({ runtime, imported })).not.toContain("never-export-this");
  });
});
