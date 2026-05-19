import { describe, expect, it } from "vitest";
import { isSafePath, areSafePaths } from "../validate";

describe("isSafePath", () => {
  it("accepts normal paths", () => {
    expect(isSafePath("/src/index.ts")).toBe(true);
    expect(isSafePath("src/index.ts")).toBe(true);
    expect(isSafePath("/hello.txt")).toBe(true);
    expect(isSafePath("/")).toBe(true);
  });

  it("accepts single-dot segments", () => {
    expect(isSafePath("./src/index.ts")).toBe(true);
    expect(isSafePath("/./src/index.ts")).toBe(true);
  });

  it("rejects paths with .. traversal", () => {
    expect(isSafePath("../etc/passwd")).toBe(false);
    expect(isSafePath("/src/../../../etc/passwd")).toBe(false);
    expect(isSafePath("..")).toBe(false);
    expect(isSafePath("/..")).toBe(false);
    expect(isSafePath("foo/../../bar")).toBe(false);
  });

  it("rejects backslash traversal", () => {
    expect(isSafePath("src\\..\\..\\etc\\passwd")).toBe(false);
    expect(isSafePath("..\\secret")).toBe(false);
  });

  it("does not false-positive on names containing dots", () => {
    expect(isSafePath("/src/my..file.ts")).toBe(true);
    expect(isSafePath("/src/...hidden")).toBe(true);
    expect(isSafePath("/src/.env.local")).toBe(true);
  });
});

describe("areSafePaths", () => {
  it("returns true when all paths are safe", () => {
    expect(areSafePaths(["/src/a.ts", "/src/b.ts"])).toBe(true);
  });

  it("returns false when any path is unsafe", () => {
    expect(areSafePaths(["/src/a.ts", "../etc/passwd"])).toBe(false);
  });

  it("returns true for empty array", () => {
    expect(areSafePaths([])).toBe(true);
  });
});
