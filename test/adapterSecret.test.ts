import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADAPTER_SECRET_HEADER, adapterTrust, clientKey, secretMatches, type AppEnv } from "../src/http/auth.js";
import { shellQuote } from "../src/cli/shell.js";
import { parseConfig, validMcpUrl } from "../src/config.js";
import { startupBanner } from "../src/banner.js";

const SECRET = "s".repeat(24);
const mk = (secret: string | null, trustProxy = false) => {
  const app = new Hono<AppEnv>();
  // mirrors production: the middleware is mounted on /api/agent/* only
  app.use("/api/agent/*", adapterTrust(secret));
  app.get("/api/agent/who", (c) => c.text(clientKey(c, trustProxy)));
  app.get("/api/state", (c) => c.text(clientKey(c, trustProxy)));
  return app;
};

describe("MNEMONIS_ADAPTER_SECRET: X-Forwarded-For on /api/agent/* only", () => {
  let url = "";
  let close: () => void = () => undefined;
  let urlNoSecret = "";
  let close2: () => void = () => undefined;
  beforeAll(async () => {
    const start = (app: Hono<AppEnv>) =>
      new Promise<{ url: string; close: () => void }>((resolve) => {
        const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (i: AddressInfo) => resolve({ url: `http://127.0.0.1:${i.port}`, close: () => void s.close() }));
      });
    const a = await start(mk(SECRET));
    ({ url, close } = a);
    const b = await start(mk(null));
    ({ url: urlNoSecret, close: close2 } = b);
  });
  afterAll(() => {
    close();
    close2();
  });
  const get = async (base: string, path: string, headers: Record<string, string>) => (await fetch(`${base}${path}`, { headers })).text();

  it("honours the last X-Forwarded-For entry when the secret matches", async () => {
    expect(await get(url, "/api/agent/who", { "X-Forwarded-For": "9.9.9.9", [ADAPTER_SECRET_HEADER]: SECRET })).toBe("9.9.9.9");
    expect(await get(url, "/api/agent/who", { "X-Forwarded-For": "1.1.1.1, 2.2.2.2", [ADAPTER_SECRET_HEADER]: SECRET })).toBe("2.2.2.2");
  });

  it("ignores a spoofed X-Forwarded-For without the secret or with a wrong one", async () => {
    expect(await get(url, "/api/agent/who", { "X-Forwarded-For": "9.9.9.9" })).toBe("127.0.0.1");
    expect(await get(url, "/api/agent/who", { "X-Forwarded-For": "9.9.9.9", [ADAPTER_SECRET_HEADER]: "x".repeat(24) })).toBe("127.0.0.1");
    expect(await get(url, "/api/agent/who", { "X-Forwarded-For": "9.9.9.9", [ADAPTER_SECRET_HEADER]: "" })).toBe("127.0.0.1");
  });

  it("never honours it on other /api routes, even with the right secret", async () => {
    expect(await get(url, "/api/state", { "X-Forwarded-For": "9.9.9.9", [ADAPTER_SECRET_HEADER]: SECRET })).toBe("127.0.0.1");
  });

  it("an unset secret keeps the current behaviour (never honoured, whatever header is sent)", async () => {
    expect(await get(urlNoSecret, "/api/agent/who", { "X-Forwarded-For": "9.9.9.9", [ADAPTER_SECRET_HEADER]: SECRET })).toBe("127.0.0.1");
  });

  it("secretMatches is exact and tolerant of any length", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches(SECRET + "x", SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
  });
});

describe("MNEMONIS_ADAPTER_SECRET / MNEMONIS_PUBLIC_MCP_URL configuration", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost/x" };
  it("secret: optional, validated, never echoed", () => {
    expect(parseConfig(base).adapterSecret).toBeNull();
    expect(parseConfig({ ...base, MNEMONIS_ADAPTER_SECRET: SECRET }).adapterSecret).toBe(SECRET);
    let msg = "";
    try {
      parseConfig({ ...base, MNEMONIS_ADAPTER_SECRET: "short secret" });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/MNEMONIS_ADAPTER_SECRET/);
    expect(msg).not.toContain("short secret");
  });
  it("MNEMONIS_PUBLIC_MCP_URL is an alias; MNEMONIS_MCP_URL wins", () => {
    expect(parseConfig({ ...base, MNEMONIS_PUBLIC_MCP_URL: "https://a.example.com/mcp" }).mcpUrl).toBe("https://a.example.com/mcp");
    expect(parseConfig({ ...base, MNEMONIS_PUBLIC_MCP_URL: "https://a.example.com/mcp", MNEMONIS_MCP_URL: "https://b.example.com/mcp" }).mcpUrl).toBe("https://b.example.com/mcp");
    expect(() => parseConfig({ ...base, MNEMONIS_PUBLIC_MCP_URL: "http://example.com/mcp" })).toThrow(/MNEMONIS_PUBLIC_MCP_URL/);
  });
});

describe("shell safety of the printed MCP URL", () => {
  const evil = [
    "https://$(touch${IFS}x).example.com/mcp",
    "https://`id`.example.com/mcp",
    "https://a.example.com;rm/mcp",
    "https://a;b.example.com/mcp",
    "https://a|b.example.com/mcp",
    "https://a&b.example.com/mcp",
    "https://a'b.example.com/mcp",
    'https://a"b.example.com/mcp',
    "https://a$b.example.com/mcp",
    "https://a b.example.com/mcp",
    "https://a.example.com/mcp'$(id)'",
    "https://a.example.com/mcp;id",
    "https://a.example.com:8788/mcp`id`",
    "https://[::1;id]/mcp",
  ];
  it("validMcpUrl rejects shell metacharacters", () => {
    for (const u of evil) expect(validMcpUrl(u), u).toBe(false);
    for (const ok of ["https://mcp.example.com/mcp", "http://localhost:8788/mcp", "http://[::1]:8788/mcp", "https://10.0.0.1:8443/mcp"]) expect(validMcpUrl(ok), ok).toBe(true);
  });
  it("shellQuote makes any string one literal word", () => {
    expect(shellQuote("http://localhost:8788/mcp")).toBe("'http://localhost:8788/mcp'");
    expect(shellQuote("a'b$(id)`x`;|& \"")).toBe(`'a'\\''b$(id)\`x\`;|& "'`);
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });
  it("the startup banner quotes the URL", () => {
    const b = startupBanner(parseConfig({ DATABASE_URL: "postgres://u:p@localhost/x", MNEMONIS_MCP_URL: "https://mcp.example.com/mcp" }), 8787);
    expect(b.lines.join("\n")).toContain("claude mcp add --transport http mnemonis 'https://mcp.example.com/mcp' --header");
  });
});
