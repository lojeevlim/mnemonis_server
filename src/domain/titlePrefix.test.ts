import { describe, expect, it } from "vitest";
import { normalizeTitle, parseTitlePrefix } from "./titlePrefix.js";

describe("parseTitlePrefix", () => {
  it("extracts the project before the first colon", () => {
    expect(parseTitlePrefix("VT: x")).toBe("VT");
    expect(parseTitlePrefix("vt : x")).toBe("vt");
    expect(parseTitlePrefix("  My App :  run: build")).toBe("My App");
  });

  it("returns null without a project or without data", () => {
    expect(parseTitlePrefix("no colon")).toBeNull();
    expect(parseTitlePrefix(": x")).toBeNull();
    expect(parseTitlePrefix("VT:")).toBeNull();
    expect(parseTitlePrefix("VT:   ")).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("ignores case and collapses whitespace but keeps short tokens", () => {
    expect(normalizeTitle("  VT   Core ")).toBe("vt core");
    expect(normalizeTitle("VT")).toBe("vt");
  });
});
