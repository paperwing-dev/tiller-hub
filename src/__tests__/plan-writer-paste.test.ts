import { describe, expect, it } from "vitest";
import {
  bracketedPasteAndSubmit,
  bracketedPasteWithoutEnter,
  bracketedTerminalPaste,
  sanitizeContributionInsert,
} from "../plan-writer-paste";

describe("Plan Writer contribution insertion", () => {
  it("strips controls and nested bracketed-paste terminators without pressing Enter", () => {
    const inserted = bracketedPasteWithoutEnter("Review\u001b[201~\u0000\u001b risk\nnext");
    expect(inserted).toBe("\u001b[200~Review risk\nnext\u001b[201~");
    expect(inserted.endsWith("\r")).toBe(false);
  });

  it("bounds inserts by UTF-8 bytes without a partial code point", () => {
    const sanitized = sanitizeContributionInsert(`${"a".repeat(64 * 1024 - 1)}é`);
    expect(new TextEncoder().encode(sanitized).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(sanitized.endsWith("�")).toBe(false);
  });

  it("keeps a large interactive terminal paste in one uncapped frame", () => {
    const plan = `# Plan\n${"- Keep this step intact\n".repeat(4_000)}`;
    const framed = bracketedTerminalPaste(plan);

    expect(new TextEncoder().encode(plan).byteLength).toBeGreaterThan(64 * 1024);
    expect(framed.startsWith("\u001b[200~# Plan\n")).toBe(true);
    expect(framed.endsWith("- Keep this step intact\n\u001b[201~")).toBe(true);
    expect(framed.length).toBe(plan.length + 12);
  });

  it("sanitizes controls that could terminate an interactive paste", () => {
    expect(bracketedTerminalPaste("Plan\u001b[201~\u0000\u001b text"))
      .toBe("\u001b[200~Plan text\u001b[201~");
  });

  it("submits direct handoffs immediately after the safe paste", () => {
    expect(bracketedPasteAndSubmit("Use this feedback"))
      .toBe("\u001b[200~Use this feedback\u001b[201~\r");
  });
});
