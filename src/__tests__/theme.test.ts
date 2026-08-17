// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getStoredThemePreference,
  initTheme,
  resolveTheme,
  resolveThemePalette,
  setThemePreference,
  THEME_STORAGE_KEY,
} from "../theme";

describe("theme preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-mode");
    document.documentElement.removeAttribute("data-theme");
  });

  it("resolves both available palettes to light mode", () => {
    expect(resolveTheme("paperwing-light")).toBe("light");
    expect(resolveTheme("classic-light")).toBe("light");
    expect(resolveThemePalette("paperwing-light")).toBe("paperwing");
    expect(resolveThemePalette("classic-light")).toBe("classic-light");
  });

  it("persists and immediately applies Classic Light", () => {
    setThemePreference("classic-light");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(
      "classic-light",
    );
    expect(getStoredThemePreference()).toBe("classic-light");
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("classic-light");
  });

  it("persists and immediately applies Paperwing Light", () => {
    setThemePreference("paperwing-light");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(
      "paperwing-light",
    );
    expect(getStoredThemePreference()).toBe("paperwing-light");
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("paperwing");
  });

  it.each(["system", "light", "dark"])(
    "migrates the legacy %s preference to Paperwing Light",
    (legacyPreference) => {
      window.localStorage.setItem(THEME_STORAGE_KEY, legacyPreference);

      initTheme();

      expect(getStoredThemePreference()).toBe("paperwing-light");
      expect(document.documentElement.dataset.mode).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("paperwing");
    },
  );
});
