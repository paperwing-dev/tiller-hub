import { describe, expect, it, vi } from "vitest";
import { readOptionalConfigValue } from "../config-row";

describe("readOptionalConfigValue", () => {
  it("returns undefined when a config row does not exist", () => {
    const exec = vi.fn().mockReturnValue({
      toArray: () => [],
    });

    expect(readOptionalConfigValue({ exec } as Pick<SqlStorage, "exec">, "missing-key")).toBeUndefined();
    expect(exec).toHaveBeenCalledWith("SELECT value FROM config WHERE key = ?", "missing-key");
  });

  it("returns the config value when a row exists", () => {
    const exec = vi.fn().mockReturnValue({
      toArray: () => [{ value: "stored-value" }],
    });

    expect(readOptionalConfigValue({ exec } as Pick<SqlStorage, "exec">, "existing-key")).toBe("stored-value");
  });
});
