import { describe, expect, it } from "vitest";
import { getHarnessDefault } from "../../shared/harness-catalog";
import { getMockDashboardEnvs } from "../mock-dashboard";

describe("mock dashboard harness settings", () => {
  it("projects a current catalog selection for every mock environment", () => {
    for (const env of getMockDashboardEnvs()) {
      expect(env.harnessSettings).toEqual(getHarnessDefault(env.harness));
    }
  });

  it("uses Kimi K2.7 for OpenCode mock environments", () => {
    const openCodeEnvs = getMockDashboardEnvs().filter((env) => env.harness === "opencode");
    expect(openCodeEnvs.length).toBeGreaterThan(0);
    expect(openCodeEnvs.every((env) => (
      env.harnessSettings?.model === "kimi-k2.7-code"
      && env.harnessSettings.effort === "high"
    ))).toBe(true);
  });

  it("assigns stable, consecutive sidebar slots within each repository", () => {
    const slotsByRepo = new Map<string, number[]>();
    for (const env of getMockDashboardEnvs()) {
      const slots = slotsByRepo.get(env.repoId) ?? [];
      slots.push(env.sidebarSlot ?? 0);
      slotsByRepo.set(env.repoId, slots);
    }

    for (const slots of slotsByRepo.values()) {
      expect(slots).toEqual(Array.from({ length: slots.length }, (_, index) => index + 1));
    }
  });
});
