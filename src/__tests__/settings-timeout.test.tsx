/**
 * @vitest-environment jsdom
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
} from "../../shared/cloudflare-timeout";
import { IdleTimeoutRow } from "../SettingsPage";

describe("IdleTimeoutRow", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeAll(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  it("uses the shared default and bounds in settings copy and validation", () => {
    const onSave = vi.fn();
    render(
      <IdleTimeoutRow
        currentMinutes={CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES}
        onSave={onSave}
      />,
    );

    expect(screen.getByText(new RegExp(`Default: ${CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES}`)))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const input = screen.getByLabelText("Idle timeout in minutes");
    expect(input).toHaveAttribute("min", String(CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES));
    expect(input).toHaveAttribute("max", String(CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES));

    fireEvent.change(input, { target: { value: String(CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES + 1) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(
      `Enter a value between ${CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES} and ${CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES} minutes.`,
    )).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
