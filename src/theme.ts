import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "tiller-theme";

const listeners = new Set<() => void>();
let systemMediaQuery: MediaQueryList | null = null;

export function getStoredThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage unavailable (e.g. some embedded contexts)
  }
  return "system";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return preference;
}

function applyResolvedTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.mode = theme;
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // best effort
  }
  applyResolvedTheme(resolveTheme(preference));
}

export function getResolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.mode === "dark" ? "dark" : "light";
}

/**
 * Apply the stored preference and track OS theme changes while the
 * preference is "system". Safe to call once at startup; the inline
 * pre-paint script in index.html has already set data-mode, so this
 * only attaches the live listener and corrects any drift.
 */
export function initTheme() {
  applyResolvedTheme(resolveTheme(getStoredThemePreference()));
  systemMediaQuery ??= window.matchMedia("(prefers-color-scheme: dark)");
  systemMediaQuery.addEventListener("change", () => {
    if (getStoredThemePreference() === "system") {
      applyResolvedTheme(resolveTheme("system"));
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the currently applied theme, re-rendering on changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => "light");
}
