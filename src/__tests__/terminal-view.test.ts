import { describe, expect, it } from "vitest";
import { getTerminalTheme, TERMINAL_MINIMUM_CONTRAST_RATIO } from "../TerminalView";

describe("getTerminalTheme", () => {
  it("keeps the browser terminal on the light palette", () => {
    const theme = getTerminalTheme();

    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#24292f");
  });

  it("enables xterm contrast correction for low-contrast ANSI colors", () => {
    expect(TERMINAL_MINIMUM_CONTRAST_RATIO).toBe(4.5);
  });
});
