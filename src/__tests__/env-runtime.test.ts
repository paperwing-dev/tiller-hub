import { describe, expect, it } from "vitest";
import {
  canStopEnvStatus,
  isEnvRunningStatus,
  shouldSelectLiveSessionForEnvStatus,
  shouldShowEnvWaitingViewForStatus,
} from "../env-runtime";

describe("env-runtime", () => {
  it("treats starting and running envs as live-session selectable", () => {
    expect(shouldSelectLiveSessionForEnvStatus("running")).toBe(true);
    expect(shouldSelectLiveSessionForEnvStatus("starting")).toBe(true);
    expect(shouldSelectLiveSessionForEnvStatus("failed")).toBe(false);
  });

  it("allows stop during starting as well as running", () => {
    expect(canStopEnvStatus("starting")).toBe(true);
    expect(canStopEnvStatus("running")).toBe(true);
    expect(canStopEnvStatus("saving")).toBe(false);
    expect(canStopEnvStatus("stopped")).toBe(false);
  });

  it("routes selected sessions back to env waiting view for non-interactive states", () => {
    expect(shouldShowEnvWaitingViewForStatus("creating")).toBe(true);
    expect(shouldShowEnvWaitingViewForStatus("saving")).toBe(true);
    expect(shouldShowEnvWaitingViewForStatus("stopping")).toBe(true);
    expect(shouldShowEnvWaitingViewForStatus("stopped")).toBe(true);
    expect(shouldShowEnvWaitingViewForStatus("failed")).toBe(true);
    expect(shouldShowEnvWaitingViewForStatus("deleting")).toBe(true);
    expect(shouldShowEnvWaitingViewForStatus("starting")).toBe(false);
    expect(shouldShowEnvWaitingViewForStatus("running")).toBe(false);
  });

  it("treats only running as a running state", () => {
    expect(isEnvRunningStatus("running")).toBe(true);
    expect(isEnvRunningStatus("starting")).toBe(false);
    expect(isEnvRunningStatus("started")).toBe(false);
  });
});
