import { afterEach, describe as baseDescribe, expect, it } from "vitest";
import { startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("/mcp moved to the separate MCP adapter", () => {
  it("answers 410 with a JSON body naming the adapter URL, for any method, without credentials", async () => {
    t = await startTestServer({ mcpUrl: "https://mcp.example.com/mcp" });
    for (const method of ["POST", "GET", "DELETE"]) {
      const r = await fetch(`${t.url}/mcp`, { method, body: method === "POST" ? "{}" : undefined });
      expect(r.status, method).toBe(410);
      const b = (await r.json()) as { error: { code: string; message: string } };
      expect(b.error.code).toBe("gone");
      expect(b.error.message).toContain("https://mcp.example.com/mcp");
    }
  });

  it("is still behind the Host and Origin guards, and names no URL when none is configured", async () => {
    t = await startTestServer();
    const evil = await fetch(`${t.url}/mcp`, { method: "POST", headers: { Origin: "http://evil.test" }, body: "{}" });
    expect(evil.status).toBe(403);
    const r = await fetch(`${t.url}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(410);
    expect(JSON.stringify(await r.json())).not.toContain("http");
  });

  it("the MCP SDK is not part of the API", async () => {
    const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty(["@modelcontextprotocol/sdk"]);
  });
});
