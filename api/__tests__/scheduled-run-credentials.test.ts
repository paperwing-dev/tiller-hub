import { describe, expect, it, vi } from "vitest";
import {
  createGitHubBridgeRecord,
  revokeGitHubBridgesForEnvironmentStart,
  type GitHubBridgeRecord,
} from "../github/bridge";

function createKv() {
  const values = new Map<string, string>();
  return {
    values,
    binding: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = values.get(key) ?? null;
        return type === "json" && value ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
      list: vi.fn(async (options?: { prefix?: string }) => ({
        keys: [...values.keys()]
          .filter((key) => key.startsWith(options?.prefix ?? ""))
          .map((name) => ({ name })),
        list_complete: true,
      })),
    },
  };
}

describe("Scheduled Run credential scopes", () => {
  it("does not let cleanup for Start A revoke a later GitHub bridge for Start B", async () => {
    const kv = createKv();
    const env = { ENVS_KV: kv.binding } as any;
    const first = await createGitHubBridgeRecord(env, {
      subject: {
        type: "interactive-env",
        envSlug: "demo",
        incarnationId: "incarnation-1",
        startOpId: "start-a",
      },
      githubFullName: "example/private-repo",
    });
    const second = await createGitHubBridgeRecord(env, {
      subject: {
        type: "interactive-env",
        envSlug: "demo",
        incarnationId: "incarnation-1",
        startOpId: "start-b",
      },
      githubFullName: "example/private-repo",
    });

    await revokeGitHubBridgesForEnvironmentStart(env, {
      envSlug: "demo",
      incarnationId: "incarnation-1",
      startOpId: "start-a",
    });

    const firstRecord = JSON.parse(kv.values.get(`github-bridge:${first.id}`)!) as GitHubBridgeRecord;
    const secondRecord = JSON.parse(kv.values.get(`github-bridge:${second.id}`)!) as GitHubBridgeRecord;
    expect(firstRecord.revokedAt).toEqual(expect.any(String));
    expect(secondRecord.revokedAt).toBeUndefined();
  });
});
