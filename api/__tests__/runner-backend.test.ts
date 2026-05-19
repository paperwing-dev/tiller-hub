import { describe, expect, it } from "vitest";
import { isLocalOnlyRunnerBackendMode, resolveScmRunnerBackendKind } from "../env/runner-backend";

describe("resolveScmRunnerBackendKind", () => {
  it("detects local-only backend mode separately from backend resolution", () => {
    expect(
      isLocalOnlyRunnerBackendMode({ LOCAL_DEV_ONLY_BACKEND: "true" } as any),
    ).toBe(true);
    expect(
      isLocalOnlyRunnerBackendMode({ LOCAL_DEV_ONLY_BACKEND: "false" } as any),
    ).toBe(false);
  });

  it("keeps SCM work on Cloudflare unless local-only development pins it to host", () => {
    expect(resolveScmRunnerBackendKind({ LOCAL_DEV_ONLY_BACKEND: undefined })).toBe("cf");
    expect(resolveScmRunnerBackendKind({ LOCAL_DEV_ONLY_BACKEND: "true" })).toBe("host");
  });
});
