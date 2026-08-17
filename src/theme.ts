import { useSyncExternalStore } from "react";

export type ThemePreference = "paperwing-light" | "classic-light";
export type ResolvedTheme = "light" | "dark";
export type ThemePalette = "paperwing" | "classic-light";

export const THEME_STORAGE_KEY = "tiller-theme";

const listeners = new Set<() => void>();

export function getStoredThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "paperwing-light" || stored === "classic-light") return stored;
  } catch {
    // localStorage unavailable (e.g. some embedded contexts)
  }
  return "paperwing-light";
}

export function resolveTheme(_preference: ThemePreference): ResolvedTheme {
  return "light";
}

export function resolveThemePalette(preference: ThemePreference): ThemePalette {
  return preference === "classic-light" ? "classic-light" : "paperwing";
}

function applyThemePreference(preference: ThemePreference) {
  document.documentElement.dataset.mode = resolveTheme(preference);
  document.documentElement.dataset.theme = resolveThemePalette(preference);
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // best effort
  }
  applyThemePreference(preference);
}

export function getResolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.mode === "dark" ? "dark" : "light";
}

/** Apply the stored light palette after the inline pre-paint bootstrap. */
export function initTheme() {
  applyThemePreference(getStoredThemePreference());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the currently applied color mode, re-rendering on changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => "light");
}
