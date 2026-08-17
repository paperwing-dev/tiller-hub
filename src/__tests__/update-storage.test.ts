/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ignoreUpdateUntilNext, isUpdateDismissed } from "../update-storage";

describe("update ignore storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("ignores only the selected update identity", () => {
    ignoreUpdateUntilNext("release-a");

    expect(isUpdateDismissed("release-a")).toBe(true);
    expect(isUpdateDismissed("release-b")).toBe(false);
  });
});
