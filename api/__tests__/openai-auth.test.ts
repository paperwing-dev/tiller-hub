import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStatus,
  getValidOpenAIAuth,
  refreshAccessToken,
  resetOpenAIAuthStateForTests,
  seedTokens,
} from "../openai-auth";

class MemoryKV {
  private store = new Map<string, string>();

  async get<T>(key: string, type?: "text" | "json"): Promise<T | string | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    if (type === "json") return JSON.parse(value) as T;
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function createTestEnv() {
  return {
    ENVS_KV: new MemoryKV(),
  } as any;
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("openai-auth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00Z"));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAIAuthStateForTests();
  });

  it("seedTokens defaults expires_in to one hour and extracts account_id from id_token", async () => {
    const env = createTestEnv();
    const accessToken = createJwt({ organizations: [{ id: "org_access" }] });
    const idToken = createJwt({ chatgpt_account_id: "acct_123" });

    const stored = await seedTokens(env, {
      access_token: accessToken,
      refresh_token: "refresh_1",
      id_token: idToken,
    });

    expect(stored.account_id).toBe("acct_123");
    expect(stored.expires_at).toBe(Date.now() + 3600 * 1000);
  });

  it("refreshAccessToken updates tokens and expiry", async () => {
    const env = createTestEnv();

    await seedTokens(env, {
      access_token: createJwt({ chatgpt_account_id: "acct_old" }),
      refresh_token: "refresh_old",
      id_token: createJwt({ chatgpt_account_id: "acct_old" }),
      expires_in: 10,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: createJwt({ chatgpt_account_id: "acct_new" }),
        refresh_token: "refresh_new",
        id_token: createJwt({ chatgpt_account_id: "acct_new" }),
        expires_in: 7200,
      }),
    }));

    const refreshed = await refreshAccessToken(env);

    expect(refreshed.access_token).not.toContain("acct_old");
    expect(refreshed.refresh_token).toBe("refresh_new");
    expect(refreshed.account_id).toBe("acct_new");
    expect(refreshed.expires_at).toBe(Date.now() + 7200 * 1000);
  });

  it("getValidOpenAIAuth returns cached tokens when still valid", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const stored = await seedTokens(env, {
      access_token: createJwt({ chatgpt_account_id: "acct_cached" }),
      refresh_token: "refresh_cached",
      id_token: createJwt({ chatgpt_account_id: "acct_cached" }),
      expires_in: 3600,
    });

    const result = await getValidOpenAIAuth(env);

    expect(result).toEqual(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("getValidOpenAIAuth coalesces concurrent refresh calls", async () => {
    const env = createTestEnv();

    await seedTokens(env, {
      access_token: createJwt({ chatgpt_account_id: "acct_old" }),
      refresh_token: "refresh_old",
      expires_in: 1,
    });

    vi.advanceTimersByTime(2000);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: createJwt({ chatgpt_account_id: "acct_new" }),
        refresh_token: "refresh_new",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const [a, b] = await Promise.all([
      getValidOpenAIAuth(env),
      getValidOpenAIAuth(env),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a.access_token).toBe(b.access_token);
    expect(a.refresh_token).toBe("refresh_new");
  });

  it("getStatus reports unauthenticated when nothing is seeded", async () => {
    const env = createTestEnv();
    await expect(getStatus(env)).resolves.toEqual({ authenticated: false });
  });
});
