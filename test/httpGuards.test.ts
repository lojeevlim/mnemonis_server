import { describe, expect, it } from "vitest";
import { createFailureLimiter, parseBearer } from "../src/http/auth.js";
import { hostAllowed } from "../src/http/cors.js";
import { createRateLimiter } from "../src/service/guards.js";

describe("parseBearer", () => {
  it("accepts one strict Bearer credential and nothing else", () => {
    expect(parseBearer("Bearer abc.def-ghi_jkl")).toBe("abc.def-ghi_jkl");
    expect(parseBearer("Bearer abc==")).toBe("abc==");
    // the scheme is case-insensitive (RFC 7235); the credential keeps its case
    expect(parseBearer("bearer AbC")).toBe("AbC");
    expect(parseBearer("BEARER AbC")).toBe("AbC");
    for (const bad of [undefined, null, "", "Bearer", "Bearer ", "Bearer  abc", "Bearer abc ", "Bearer a b", "Bearer a, Bearer b", "Basic abc", "Bearer a=b", `Bearer ${"a".repeat(9000)}`, "Bearer a\nb"]) {
      expect(parseBearer(bad as string | undefined), String(bad)).toBeNull();
    }
  });
});

describe("hostAllowed", () => {
  it("permits loopback:port and exact case-insensitive extra hosts", () => {
    expect(hostAllowed("localhost:8787", 8787)).toBe(true);
    expect(hostAllowed("LOCALHOST:8787", 8787)).toBe(true);
    expect(hostAllowed("localhost", 8787)).toBe(false);
    expect(hostAllowed("localhost:1", 8787)).toBe(false);
    expect(hostAllowed(undefined, 8787, ["a.test"])).toBe(false);
    expect(hostAllowed("A.Test", 8787, ["a.test"])).toBe(true);
    expect(hostAllowed("a.test:8787", 8787, ["a.test"])).toBe(false);
    expect(hostAllowed("evil.test", 8787, ["a.test"])).toBe(false);
  });
});

describe("bounded maps", () => {
  it("the write rate limiter caps tracked keys (oldest evicted) and forgets expired keys", () => {
    let now = 0;
    const l = createRateLimiter({ max: 1, windowMs: 1000, maxKeys: 2, now: () => now });
    l.take("a");
    l.take("b");
    l.take("c"); // evicts a
    expect(() => l.take("c")).toThrowError(/Too many writes/);
    expect(() => l.take("a")).not.toThrow(); // a was evicted (and evicts b)
    now = 5000;
    expect(() => l.take("c")).not.toThrow(); // window passed
  });

  it("the failure limiter blocks at max, recovers after the window and stays bounded", () => {
    let now = 0;
    const l = createFailureLimiter({ max: 2, windowMs: 1000, maxKeys: 2, now: () => now });
    l.fail("x");
    expect(l.blocked("x")).toBe(false);
    l.fail("x");
    expect(l.blocked("x")).toBe(true);
    expect(l.blocked("y")).toBe(false);
    now = 1001;
    expect(l.blocked("x")).toBe(false);
    l.fail("p");
    l.fail("p");
    l.fail("q");
    l.fail("r"); // over maxKeys: oldest evicted
    expect(l.blocked("p")).toBe(false);
  });
});
