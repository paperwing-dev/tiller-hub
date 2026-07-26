import { describe, expect, it } from "vitest";
import {
  PLAN_DEFAULT_MODEL,
  coercePlanModelSelection,
  getFallbackPlanModel,
  isChatGPTPlanModel,
} from "../plan-models";

describe("plan-models", () => {
  it("identifies the ChatGPT plan model", () => {
    expect(isChatGPTPlanModel("gpt-5.5")).toBe(true);
    expect(isChatGPTPlanModel("@cf/moonshotai/kimi-k2.7-code")).toBe(false);
  });

  it("returns a non-ChatGPT fallback model", () => {
    expect(getFallbackPlanModel()).not.toBe(PLAN_DEFAULT_MODEL);
    expect(isChatGPTPlanModel(getFallbackPlanModel())).toBe(false);
  });

  it("coerces stored subscription selections when the subscription route is unavailable", () => {
    expect(
      coercePlanModelSelection("gpt-5.5", {
        chatgptAvailable: false,
      }),
    ).toBe(getFallbackPlanModel());
  });

  it("preserves non-ChatGPT selections when ChatGPT is unavailable", () => {
    expect(
      coercePlanModelSelection("@cf/moonshotai/kimi-k2.7-code", {
        chatgptAvailable: false,
      }),
    ).toBe("@cf/moonshotai/kimi-k2.7-code");
  });
});
