import { describe, expect, it } from "vitest";
import {
  getTerminalTheme,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  translateTerminalKeyEvent,
} from "../TerminalView";

function terminalKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: "keydown",
    key: "Backspace",
    metaKey: true,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    repeat: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("translateTerminalKeyEvent", () => {
  it("translates exact and repeated Meta+Backspace keydown events to Ctrl+U", () => {
    expect(translateTerminalKeyEvent(terminalKeyEvent())).toBe("\x15");
    expect(translateTerminalKeyEvent(terminalKeyEvent({ repeat: true }))).toBe("\x15");
  });

  it("ignores keyup and IME composition", () => {
    expect(translateTerminalKeyEvent(terminalKeyEvent({ type: "keyup" }))).toBeNull();
    expect(translateTerminalKeyEvent(terminalKeyEvent({ isComposing: true }))).toBeNull();
  });

  it.each([
    ["ordinary Backspace", { metaKey: false }],
    ["Shift+Meta+Backspace", { shiftKey: true }],
    ["Option+Meta+Backspace", { altKey: true }],
    ["Control+Meta+Backspace", { ctrlKey: true }],
    ["an unrelated Command shortcut", { key: "c" }],
    ["the forward Delete key", { key: "Delete" }],
  ])("ignores %s", (_label, overrides) => {
    expect(translateTerminalKeyEvent(terminalKeyEvent(overrides))).toBeNull();
  });
});

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
