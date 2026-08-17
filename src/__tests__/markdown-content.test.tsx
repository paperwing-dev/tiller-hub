/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MarkdownContent from "../MarkdownContent";

describe("MarkdownContent", () => {
  afterEach(cleanup);

  it("separates fenced-block styling from inline code styling", () => {
    const { container } = render(
      <MarkdownContent className="tiller-plan-document">
        {"Use `inline()` here.\n\n```ts\nconst answer = 42;\n```"}
      </MarkdownContent>,
    );

    const block = container.querySelector("pre.tiller-markdown-pre");
    const blockCode = block?.querySelector(":scope > code.tiller-markdown-code");
    const inlineCode = container.querySelector("p > code.tiller-markdown-code");

    expect(block).not.toBeNull();
    expect(blockCode).not.toBeNull();
    expect(blockCode).toHaveClass("language-ts");
    expect(inlineCode).toHaveTextContent("inline()");
  });
});
