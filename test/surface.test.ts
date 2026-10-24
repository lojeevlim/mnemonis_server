import { afterEach, beforeEach, describe as baseDescribe, expect, it } from "vitest";
import { startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

let t: TestServer;
beforeEach(async () => {
  t = await startTestServer();
});
afterEach(async () => {
  await t.close();
});

const json = { "Content-Type": "application/json" };
const bearer = (c: string) => ({ Authorization: `Bearer ${c}` });
/** The agent surface: GET /api/agent/ping is 200 for a valid mn_ token, the uniform 401 otherwise. */
const mcp = (headers: Record<string, string>, query = "") => fetch(`${t.url}/api/agent/ping${query}`, { headers: { "X-Mnemonis-Contract": "1", ...headers } });

async function shape(r: Response) {
  const headers = [...r.headers.entries()].filter(([k]) => k !== "date" && k !== "x-request-id").sort(([a], [b]) => a.localeCompare(b));
  return { status: r.status, body: await r.text(), headers };
}

describe("surface separation: sessions only on /api, mn_ tokens only on /api/agent", () => {
  it("a login session is a 401 on /api/agent, identical to no credentials", async () => {
    const nothing = await shape(await mcp({}));
    expect(nothing.status).toBe(401);
    expect(await shape(await mcp(bearer(t.a.session)))).toEqual(nothing);
    // the same user's mcp token on the same route works, so the 401 is about the credential type
    const { token } = await t.a.mcpToken();
    expect((await mcp(bearer(token))).status).toBe(200);
  });

  it("an mn_ token is a 401 on every /api route, including the account, token and public-adjacent ones", async () => {
    const { token } = await t.a.mcpToken();
    const baseline = await shape(await fetch(`${t.url}/api/state`));
    expect(baseline.status).toBe(401);
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/state"],
      ["PUT", "/api/state", {}],
      ["GET", "/api/export"],
      ["GET", "/api/me"],
      ["GET", "/api/auth/me"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/password", { currentPassword: t.a.password, newPassword: "a-different-long-passphrase-1" }],
      ["DELETE", "/api/auth/me", { password: t.a.password }],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens", { label: "escalate" }],
      ["DELETE", "/api/tokens/00000000-0000-4000-8000-000000000000"],
      ["POST", "/api/ops/approve", { revisionId: "x" }],
      ["POST", "/api/ops/createMemory", { title: "x" }],
      ["GET", "/api/anything-else"],
    ];
    for (const [method, path, body] of routes) {
      const r = await fetch(`${t.url}${path}`, { method, headers: { ...json, ...bearer(token) }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(await shape(r), `${method} ${path}`).toEqual(baseline);
    }
    // nothing changed: the user and the tokens are intact and no token was minted
    expect((await t.a.api("/api/auth/me")).status).toBe(200);
    const list = (await (await t.a.api("/api/tokens")).json()) as { tokens: { label: string; revokedAt: string | null }[] };
    expect(list.tokens.map((x) => x.label)).toEqual(["test"]);
    expect(list.tokens[0]!.revokedAt).toBeNull();
  });

  it("shape confusion: look-alike credentials never cross over", async () => {
    const { token } = await t.a.mcpToken();
    const sessionBody = t.a.session.slice(3);
    const mnBody = token.slice(3);
    const cases: Record<string, Record<string, string>> = {
      "mn_ token in an ms_ costume": bearer(`ms_${mnBody}`),
      "ms_ token in an mn_ costume": bearer(`mn_${sessionBody}`),
      "session body without prefix": bearer(sessionBody),
      "mn token body without prefix": bearer(mnBody),
      "both credentials in one value": bearer(`${t.a.session},${token}`),
      "session then mn token separated by a space": { Authorization: `Bearer ${t.a.session} ${token}` },
      "trailing garbage": bearer(`${t.a.session}x`),
      "token in x-api-key": { "X-API-Key": token },
      "session in a cookie": { Cookie: `session=${t.a.session}; token=${token}` },
      "basic auth carrying the token": { Authorization: `Basic ${Buffer.from(`user:${token}`).toString("base64")}` },
    };
    const apiBaseline = await shape(await fetch(`${t.url}/api/state`));
    const mcpBaseline = await shape(await mcp({}));
    for (const [name, h] of Object.entries(cases)) {
      expect({ name, ...(await shape(await fetch(`${t.url}/api/state`, { headers: h }))) }, name).toEqual({ name, ...apiBaseline });
      expect({ name, ...(await shape(await mcp(h))) }, name).toEqual({ name, ...mcpBaseline });
    }
  });

  it("credentials in the URL are ignored on both surfaces", async () => {
    const { token } = await t.a.mcpToken();
    const q = `access_token=${t.a.session}&token=${token}&authorization=Bearer%20${token}`;
    expect((await fetch(`${t.url}/api/state?${q}`)).status).toBe(401);
    expect((await mcp({}, `?${q}`)).status).toBe(401);
  });

  it("the credential type, not a retry, decides: a wrong-surface credential does not fall through to the other verifier", async () => {
    let session = 0;
    let mcpCalls = 0;
    await t.close();
    t = await startTestServer({
      accounts: (real) => ({
        ...real,
        verifySession: (x) => (session++, real.verifySession(x)),
        verifyMcp: (x) => (mcpCalls++, real.verifyMcp(x)),
      }),
    });
    const { token } = await t.a.mcpToken();
    await fetch(`${t.url}/api/state`, { headers: bearer(token) });
    await mcp(bearer(t.a.session));
    expect({ session, mcpCalls }).toEqual({ session: 0, mcpCalls: 0 });
    await fetch(`${t.url}/api/state`, { headers: bearer(t.a.session) });
    await mcp(bearer(token));
    expect({ session, mcpCalls }).toEqual({ session: 1, mcpCalls: 1 });
  });

  it("the account endpoints are session-only: logging out kills REST but the user's mcp tokens keep working", async () => {
    const { token } = await t.a.mcpToken();
    expect((await t.a.api("/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await t.a.api("/api/state")).status).toBe(401);
    expect((await mcp(bearer(token))).status).toBe(200);
  });

  it("changing the password or deleting the account behaves per surface: delete kills mcp tokens too", async () => {
    const victim = await t.makeUser("gone");
    const { token } = await victim.mcpToken();
    expect((await mcp(bearer(token))).status).toBe(200);
    const del = await fetch(`${t.url}/api/auth/me`, { method: "DELETE", headers: victim.headers(json), body: JSON.stringify({ password: victim.password }) });
    expect(del.status).toBe(204);
    expect((await mcp(bearer(token))).status).toBe(401);
  });
});
