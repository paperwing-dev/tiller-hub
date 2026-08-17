import { describe, expect, it } from "vitest";
import {
  deriveEnvDisplayName,
  normalizeEnvDisplayName,
} from "../../../shared/env-display-name";

describe("environment display names", () => {
  it("normalizes titles to a safe single line", () => {
    expect(deriveEnvDisplayName({
      title: "  First\n\tsecond\u0000\u0085\u200B\u202E  third  ",
    }, 3)).toBe("First second third");
  });

  it("neutralizes ANSI escape characters", () => {
    expect(deriveEnvDisplayName({ title: "\u001B[31mDanger\u001B[0m" }, 1))
      .toBe("[31mDanger [0m");
  });

  it("limits names to 80 Unicode code points", () => {
    const exact = "😀".repeat(80);
    expect(normalizeEnvDisplayName(exact)).toBe(exact);
    expect(deriveEnvDisplayName({ title: `${exact}x` }, 1))
      .toBe(`${"😀".repeat(79)}…`);
    expect(Array.from(deriveEnvDisplayName({ title: `${exact}x` }, 1))).toHaveLength(80);
  });

  it("uses slot-derived fallbacks for titleless plans and scratch environments", () => {
    expect(deriveEnvDisplayName({ title: "\u0000\u200B\n" }, 7)).toBe("Plan #7");
    expect(deriveEnvDisplayName(null, 4)).toBe("Scratch #4");
  });

  it("allows duplicate normalized plan titles", () => {
    expect([
      deriveEnvDisplayName({ title: "Shared\nname" }, 1),
      deriveEnvDisplayName({ title: " Shared name " }, 2),
    ]).toEqual(["Shared name", "Shared name"]);
  });
});
