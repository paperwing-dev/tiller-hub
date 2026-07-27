import { describe, expect, it } from "vitest";
import { isLocalOnlyRunnerBackendMode } from "../env/runner-backend";

describe("isLocalOnlyRunnerBackendMode", () => {
  it("recognizes the contributor-only localhost override", () => {
    expect(
      isLocalOnlyRunnerBackendMode({ LOCAL_DEV_ONLY_BACKEND: "true" } as any),
    ).toBe(true);
    expect(
      isLocalOnlyRunnerBackendMode({ LOCAL_DEV_ONLY_BACKEND: "false" } as any),
    ).toBe(false);
  });
});
