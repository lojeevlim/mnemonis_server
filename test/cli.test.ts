import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "../src/cli/run.js";
import { readHidden } from "../src/cli/prompt.js";
import { loadCliEnv, parseEnvFile } from "../src/cli/env.js";
import { clearSession, loadSession, saveSession, sessionPaths, type Session } from "../src/cli/session.js";
import { parseOrigin } from "../src/cli/http.js";
import { hasUnsafeChars } from "../src/auth/sanitize.js";
import { startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const API = "http://127.0.0.1:8787";
const FAR_ISO = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
/** A session bound to API unless overridden. */
const sess = (o: Partial<Session> = {}): Session => ({ token: `ms_${"A".repeat(43)}`, expiresAt: FAR_ISO(), apiUrl: API, ...o });

interface MockApi {
  url: string;
  hits: string[];
  close: () => Promise<void>;
}
/** A throwaway local HTTP server standing in for the Mnemonis API. */
async function mockApi(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<MockApi> {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => handler(req, res, b));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}
const json = (res: ServerResponse, v: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mn-cli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { env: {}, out: (l) => out.push(l), err: (l) => err.push(l), home, ...extra };
  return { out, err, run: (...argv: string[]) => runCli(argv, deps), text: () => [...out, ...err].join("\n") };
}

describe("session store", () => {
  it("writes the dir 0700 and the file 0600 and round-trips", () => {
    const s = sess();
    saveSession(s, home);
    const { dir, file } = sessionPaths(home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadSession(home)).toEqual(s);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["apiUrl", "expiresAt", "token"]);
  });
  it("tightens a loose dir on save", () => {
    saveSession(sess(), home);
    const { dir, file } = sessionPaths(home);
    chmodSync(dir, 0o755);
    saveSession(sess({ token: "b" }), home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("refuses to load a file with loose permissions", () => {
    saveSession(sess(), home);
    chmodSync(sessionPaths(home).file, 0o644);
    expect(() => loadSession(home)).toThrow(/permissions are 644/);
    chmodSync(sessionPaths(home).file, 0o640);
    expect(() => loadSession(home)).toThrow(/must be 600/);
  });
  it("refuses a symlinked session file and a non-regular file", () => {
    saveSession(sess(), home);
    const { dir, file } = sessionPaths(home);
    const real = join(dir, "real.json");
    writeFileSync(real, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(real, file);
    expect(() => loadSession(home)).toThrow(/Refusing/);
    rmSync(file);
    mkdirSync(file);
    expect(() => loadSession(home)).toThrow(/Refusing/);
  });
  it("refuses a symlinked session directory for save, load and clear", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mn-cli-else-"));
    try {
      symlinkSync(elsewhere, sessionPaths(home).dir);
      expect(() => saveSession(sess(), home)).toThrow(/symlink/);
      expect(() => loadSession(home)).toThrow(/symlink/);
      expect(() => clearSession(home)).toThrow(/symlink/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
  it("ignores leftover tmp files and leaves no tmp behind, even when the save fails", () => {
    saveSession(sess(), home);
    const { dir, file } = sessionPaths(home);
    writeFileSync(`${file}.1234.tmp`, "stale", { mode: 0o600 });
    saveSession(sess({ token: "b" }), home);
    expect(readdirSync(dir).sort()).toEqual(["cli-session.json", "cli-session.json.1234.tmp"]);
    expect(loadSession(home)?.token).toBe("b");
    // a failing rename (target is a directory) must unlink its own tmp
    rmSync(file);
    mkdirSync(file);
    expect(() => saveSession(sess(), home)).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["cli-session.json", "cli-session.json.1234.tmp"]);
  });
  it("clear deletes; corrupt or incomplete file reads as no session", () => {
    saveSession(sess(), home);
    expect(clearSession(home)).toBe(true);
    expect(existsSync(sessionPaths(home).file)).toBe(false);
    expect(clearSession(home)).toBe(false);
    saveSession(sess(), home);
    writeFileSync(sessionPaths(home).file, "{nope", { mode: 0o600 });
    expect(loadSession(home)).toBeNull();
    writeFileSync(sessionPaths(home).file, JSON.stringify({ token: "a", expiresAt: "x" }), { mode: 0o600 });
    expect(loadSession(home)).toBeNull();
  });
});

describe("URL validation", () => {
  const ok: [string, string][] = [
    ["https://abc.supabase.co", "https://abc.supabase.co"],
    ["https://abc.supabase.co/", "https://abc.supabase.co"],
    ["https://abc.supabase.co/some/path/", "https://abc.supabase.co"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://127.9.9.9", "http://127.9.9.9"],
    ["http://[::1]:8787", "http://[::1]:8787"],
    ["https://example.com:8443", "https://example.com:8443"],
  ];
  it.each(ok)("accepts %s as %s", (raw, origin) => expect(parseOrigin("X_URL", raw)).toBe(origin));
  const bad = [
    "http://example.com",
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://10.0.0.1",
    "ftp://example.com",
    "javascript:alert(1)",
    "not a url",
    "",
    "https://user:hunter2@example.com",
    "https://user@example.com",
    "https://example.com?a=1",
    "https://example.com?",
    "https://example.com#frag",
    "https://example.com/#",
  ];
  it.each(bad)("refuses %j naming only the variable", (raw) => {
    let msg = "";
    try {
      parseOrigin("X_URL", raw);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^X_URL /);
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("example.com");
  });
  it("the CLI validates the server URL before any prompt or network call", async () => {
    for (const url of ["https://u:p@example.com", "http://evil.example", "https://example.com?x=1"]) {
      let touched = false;
      const h = harness({
        env: { MNEMONIS_API_URL: url },
        askLine: async () => ((touched = true), "a@b.c"),
        askPassword: async () => ((touched = true), "pw"),
        fetch: (async () => ((touched = true), new Response("{}"))) as typeof fetch,
      });
      expect(await h.run("login")).toBe(1);
      expect(touched).toBe(false);
      expect(h.err.join("")).toMatch(/MNEMONIS_API_URL/);
      expect(h.text()).not.toMatch(/evil\.example|u:p/);
    }
    const h = harness({ env: { MNEMONIS_API_URL: "http://example.com" }, fetch: (async () => { throw new Error("no"); }) as typeof fetch });
    expect(await h.run("health")).toBe(1);
    expect(h.err.join("")).toMatch(/MNEMONIS_API_URL/);
  });
});

describe(".env handling", () => {
  it("reads only the CLI key, never anything else", () => {
    const parsed = parseEnvFile(
      ["# c", "DATABASE_URL=postgres://u:secret@h/db", 'export SUPABASE_URL="https://x.supabase.co"', "MNEMONIS_API_URL=http://127.0.0.1:1 # note", "OTHER=1"].join("\n"),
      ["MNEMONIS_API_URL"],
    );
    expect(parsed).toEqual({ MNEMONIS_API_URL: "http://127.0.0.1:1" });
  });
  it("loadCliEnv prefers process.env, falls back to the file, and drops unrelated variables", () => {
    const f = join(home, ".env");
    writeFileSync(f, "DATABASE_URL=postgres://secret\nMNEMONIS_API_URL=https://file.example\n");
    expect(loadCliEnv({ MNEMONIS_API_URL: "https://proc.example", DATABASE_URL: "postgres://proc", PATH: "/bin" }, f)).toEqual({ MNEMONIS_API_URL: "https://proc.example" });
    const env = loadCliEnv({ DATABASE_URL: "postgres://proc", PATH: "/bin" }, f);
    expect(env).toEqual({ MNEMONIS_API_URL: "https://file.example" });
    expect(JSON.stringify(env)).not.toContain("postgres");
    expect(loadCliEnv({}, join(home, "missing.env"))).toEqual({ MNEMONIS_API_URL: undefined });
  });
});

describe("hidden prompt", () => {
  it("refuses non-TTY input", async () => {
    const input = new PassThrough();
    await expect(readHidden("Password: ", { input, output: new PassThrough() })).rejects.toThrow(/interactively/);
  });
  it("does not echo what is typed", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = new PassThrough();
    let seen = "";
    output.on("data", (d) => (seen += d));
    const p = readHidden("Password: ", { input, output });
    input.write("hunter2-secret\n");
    expect(await p).toBe("hunter2-secret");
    expect(seen).toContain("Password: ");
    expect(seen).not.toContain("hunter2");
  });
  it("login rejects a password in argv and never uses it", async () => {
    let called = false;
    const h = harness({
      env: { MNEMONIS_API_URL: "http://127.0.0.1:1" },
      fetch: (async () => ((called = true), new Response("{}"))) as typeof fetch,
    });
    for (const a of [["--password", "topsecret"], ["--password=topsecret"]]) {
      expect(await h.run("login", "--email", "a@b.c", ...a)).toBe(1);
    }
    expect(called).toBe(false);
    expect(h.text()).not.toContain("topsecret");
  });
});

describe("auth against a mock Mnemonis server", () => {
  let calls: { method: string; path: string; body: Record<string, string>; auth: string | undefined }[];
  let respond: (path: string, body: Record<string, string>) => { status: number; json?: unknown };
  let api: MockApi;
  beforeAll(async () => {
    api = await mockApi((req, res, raw) => {
      const body = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      calls.push({ method: req.method ?? "", path: req.url ?? "", body, auth: req.headers.authorization });
      const r = respond(req.url ?? "", body);
      res.writeHead(r.status, { "Content-Type": "application/json" }).end(r.json === undefined ? undefined : JSON.stringify(r.json));
    });
  });
  afterAll(() => api.close());
  beforeEach(() => {
    calls = [];
    respond = (path) =>
      path === "/api/auth/login"
        ? { status: 200, json: { token: `ms_${"B".repeat(43)}`, expiresAt: FAR_ISO(), user: { id: "1", email: "e", displayName: "d" } } }
        : path === "/api/auth/logout"
          ? { status: 204 }
          : { status: 200, json: { id: "1", email: "e", displayName: "d" } };
  });
  const env = () => ({ MNEMONIS_API_URL: api.url });

  it("login posts email and password to /api/auth/login and stores the session but never the password", async () => {
    const h = harness({ env: env(), askPassword: async () => "s3cret-pw-long" });
    expect(await h.run("login", "--email", "me@example.test")).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/auth/login", body: { email: "me@example.test", password: "s3cret-pw-long" }, auth: undefined }]);
    expect(readFileSync(sessionPaths(home).file, "utf8")).not.toContain("s3cret-pw-long");
    expect(loadSession(home)).toMatchObject({ token: `ms_${"B".repeat(43)}`, apiUrl: api.url });
    expect(h.text()).not.toContain("s3cret-pw-long");
    expect(h.out.join("")).toContain(sessionPaths(home).file);
  });
  it("failed login prints the server message cleanly and stores nothing", async () => {
    respond = () => ({ status: 401, json: { error: { code: "invalid_credentials", message: "Invalid email or password" } } });
    const h = harness({ env: env(), askPassword: async () => "wrong-pw-long-1" });
    expect(await h.run("login", "--email", "me@example.test")).toBe(1);
    expect(h.err.join("")).toContain("Invalid email or password");
    expect(h.err.join("")).toContain("401");
    expect(h.text()).not.toContain("wrong-pw-long-1");
    expect(loadSession(home)).toBeNull();
  });
  it("a malformed login response is refused and stores nothing", async () => {
    respond = () => ({ status: 200, json: { nope: true } });
    const h = harness({ env: env(), askPassword: async () => "pw-long-enough-1" });
    expect(await h.run("login", "--email", "me@example.test")).toBe(1);
    expect(loadSession(home)).toBeNull();
  });
  it("sends the stored session as Bearer; a 401 asks for login (no refresh, no retry)", async () => {
    saveSession(sess({ token: "ms_the-session", apiUrl: api.url }), home);
    const h = harness({ env: env() });
    expect(await h.run("me")).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: "/api/me", body: {}, auth: "Bearer ms_the-session" }]);
    calls = [];
    respond = () => ({ status: 401, json: { error: { code: "unauthorized", message: "no" } } });
    const g = harness({ env: env() });
    expect(await g.run("me")).toBe(1);
    expect(calls).toHaveLength(1);
    expect(g.err.join("")).toMatch(/login/);
    expect(g.text()).not.toContain("ms_the-session");
  });
  it("refuses to use a session issued for a different server", async () => {
    const fetched: string[] = [];
    const f = (async (u: string) => (fetched.push(String(u)), new Response("{}"))) as unknown as typeof fetch;
    saveSession(sess({ apiUrl: api.url }), home);
    const h = harness({ env: { MNEMONIS_API_URL: "http://127.0.0.1:9" }, fetch: f });
    expect(await h.run("me")).toBe(1);
    expect(h.err.join("")).toMatch(/different MNEMONIS_API_URL.*login again/);
    expect(fetched).toEqual([]);
  });
  it("logout revokes on the server with the session and deletes the file", async () => {
    saveSession(sess({ token: "ms_to-revoke", apiUrl: api.url }), home);
    const h = harness({ env: env() });
    expect(await h.run("logout")).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/auth/logout", body: {}, auth: "Bearer ms_to-revoke" }]);
    expect(h.out.join("")).toMatch(/revoked on the server/);
    expect(existsSync(sessionPaths(home).file)).toBe(false);
  });
  it("logout says plainly when it could only delete locally, and never sends a session to another host", async () => {
    respond = () => ({ status: 500, json: {} });
    saveSession(sess({ apiUrl: api.url }), home);
    const h = harness({ env: env() });
    expect(await h.run("logout")).toBe(0);
    expect(h.out.join("")).toMatch(/deleted only; NOT revoked on the server/);
    expect(existsSync(sessionPaths(home).file)).toBe(false);
    calls = [];
    saveSession(sess({ apiUrl: api.url }), home);
    const g = harness({ env: { MNEMONIS_API_URL: "http://127.0.0.1:9" } });
    expect(await g.run("logout")).toBe(0);
    expect(g.out.join("")).toMatch(/NOT revoked/);
    expect(calls).toEqual([]);
    const none = harness({ env: env() });
    expect(await none.run("logout")).toBe(0);
    expect(none.out.join("")).toBe("No stored session.");
  });

  it("every request refuses redirects and carries a timeout signal", async () => {
    const seen: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) =>
      (seen.push(init), new Response(JSON.stringify({ token: "ms_x", expiresAt: FAR_ISO() })))) as unknown as typeof fetch;
    await harness({ env: env(), askPassword: async () => "pw", fetch: f }).run("login", "--email", "a@b.c");
    await harness({ env: env(), fetch: f }).run("me");
    await harness({ env: env(), fetch: f }).run("logout");
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const init of seen) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it("does not follow a redirect (the session never reaches the target)", async () => {
    const target = await mockApi((_q, res) => json(res, { id: "x", email: "stolen", displayName: "d" }));
    const redirector = await mockApi((_q, res) => res.writeHead(302, { Location: `${target.url}/api/me` }).end());
    try {
      saveSession(sess({ apiUrl: redirector.url }), home);
      const h = harness({ env: { MNEMONIS_API_URL: redirector.url } });
      expect(await h.run("me")).toBe(1);
      expect(h.err.join("")).toMatch(/Cannot reach/);
      expect(target.hits).toEqual([]);
      const g = harness({ env: { MNEMONIS_API_URL: redirector.url }, askPassword: async () => "pw" });
      expect(await g.run("login", "--email", "a@b.c")).toBe(1);
      expect(target.hits).toEqual([]);
    } finally {
      await redirector.close();
      await target.close();
    }
  });
  it("gives up on a server that never answers", async () => {
    const hang = await mockApi(() => undefined);
    try {
      saveSession(sess({ apiUrl: hang.url }), home);
      const h = harness({ env: { MNEMONIS_API_URL: hang.url }, timeoutMs: 150 });
      const t0 = Date.now();
      expect(await h.run("me")).toBe(1);
      expect(h.err.join("")).toMatch(/Cannot reach/);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(await harness({ env: { MNEMONIS_API_URL: hang.url }, timeoutMs: 150 }).run("health")).toBe(1);
    } finally {
      await hang.close();
    }
  });
});

describe("no session / unreachable server", () => {
  it("asks to log in without a session", async () => {
    const h = harness({ env: {} });
    expect(await h.run("me")).toBe(1);
    expect(h.err.join("")).toMatch(/login/);
  });
  it("reports an unreachable server without a stack trace or token", async () => {
    saveSession(sess({ token: "tok-secret", apiUrl: "http://127.0.0.1:1" }), home);
    const h = harness({ env: { MNEMONIS_API_URL: "http://127.0.0.1:1" } });
    expect(await h.run("me")).toBe(1);
    expect(h.text()).toMatch(/Cannot reach/);
    expect(h.text()).not.toMatch(/tok-secret|\n\s+at /);
  });
  it("unknown command exits non-zero; usage without a command goes to stderr", async () => {
    expect(await harness().run("bogus")).toBe(1);
    const h = harness();
    expect(await h.run()).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toMatch(/Usage:/);
    const g = harness();
    expect(await g.run("help")).toBe(0);
    expect(g.out.join("")).toMatch(/Usage:/);
  });
  it("validates --days locally (1..365) before any request", async () => {
    let called = false;
    for (const d of ["0", "366", "-1", "abc", "1.5", "1000", ""]) {
      const h = harness({ fetch: (async () => ((called = true), new Response("{}"))) as typeof fetch });
      expect(await h.run("tokens", "create", "x", `--days=${d}`)).toBe(1);
      expect(h.err.join("")).toMatch(/--days/);
    }
    expect(called).toBe(false);
  });
});

describe.skipIf(!TEST_DB_URL)("CLI against a real test server", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer({ mcpUrl: "http://localhost:8788/mcp" });
  });
  afterAll(async () => {
    await t.close();
  });
  const cli = async (user = t.a) => {
    saveSession(sess({ token: user.session, apiUrl: t.url }), home);
    return harness({ env: { MNEMONIS_API_URL: t.url } });
  };

  it("health and me", async () => {
    const h = await cli();
    expect(await h.run("health")).toBe(0);
    expect(h.out.join("")).toContain("OK");
    expect(await h.run("me")).toBe(0);
    expect(h.out.join("\n")).toContain(t.a.email);
    expect(h.out.join("\n")).toContain(t.a.displayName);
  });

  it("tokens create/list/revoke prints the token once with the claude line", async () => {
    const h = await cli();
    expect(await h.run("tokens", "create", "my laptop", "--days", "7")).toBe(0);
    const text = h.out.join("\n");
    const token = /mn_[A-Za-z0-9_-]+/.exec(text)?.[0];
    expect(token).toBeTruthy();
    expect(text.split(token!).length - 1).toBe(1); // printed exactly once
    expect(text).toMatch(/shell history/);
    expect(text).toMatch(/long-lived/);
    expect(text).toContain(`claude mcp add --transport http mnemonis http://localhost:8788/mcp --header "Authorization: Bearer ${token}"`);
    const id = /Token (\S+) created/.exec(text)![1]!;
    h.out.length = 0;
    expect(await h.run("tokens", "list")).toBe(0);
    expect(h.out.join("\n")).toContain("my laptop");
    expect(h.out.join("\n")).not.toContain(token!);
    expect(await h.run("tokens", "revoke", id)).toBe(0);
    h.out.length = 0;
    await h.run("tokens", "list");
    expect(h.out.join("\n")).toContain("revoked");
    expect(await h.run("tokens", "create", "x", "--days", "0")).toBe(1);
    expect(h.err.join("")).toMatch(/--days/);
  });

  it("inbox lists agent proposals; approve, reject and approve-all work", async () => {
    const agent = { kind: "agent", name: "claude-test" };
    const mk = async (title: string) => {
      const r = (await (await t.op("createMemory", { title, content: "c", actor: agent })).json()) as { state: { revisions: Record<string, { id: string; memoryId: string; snapshot: { title: string } }> } };
      return Object.values(r.state.revisions).find((x) => x.snapshot.title === title)!.id;
    };
    const r1 = await mk("Proposal one");
    const r2 = await mk("Proposal two");
    const r3 = await mk("Proposal three");
    const h = await cli();
    expect(await h.run("inbox")).toBe(0);
    let text = h.out.join("\n");
    for (const id of [r1, r2, r3]) expect(text).toContain(id);
    expect(text).toContain("Proposal one");
    expect(text).toContain("claude-test");

    expect(await h.run("approve", r1)).toBe(0);
    expect(await h.run("reject", r2)).toBe(0);
    h.out.length = 0;
    await h.run("inbox");
    text = h.out.join("\n");
    expect(text).not.toContain(r1);
    expect(text).not.toContain(r2);
    expect(text).toContain(r3);

    // approve-all needs --yes or a TTY confirmation
    const noTty = await cli();
    expect(await runCli(["approve-all"], { env: { MNEMONIS_API_URL: t.url }, out: () => undefined, err: (l) => noTty.err.push(l), home, io: { input: new PassThrough(), output: new PassThrough() } })).toBe(1);
    expect(noTty.err.join("")).toMatch(/--yes/);
    expect(noTty.err.join("")).toMatch(/1 revision\(s\)/);
    let asked = "";
    const no = await cli();
    no.err.length = 0;
    expect(await runCli(["approve-all"], { env: { MNEMONIS_API_URL: t.url }, out: (l) => no.out.push(l), err: () => undefined, home, confirm: async (q) => ((asked = q), false) })).toBe(1);
    expect(asked).toMatch(/1 revision\(s\) and 0 relation\(s\)/);
    expect((await t.a.service.getState()).state.revisions[r3]!.status).toBe("pending");
    expect(await h.run("approve-all", "--yes")).toBe(0);
    expect(h.out.join("\n")).toMatch(/1 revision\(s\)/);
    h.out.length = 0;
    await h.run("inbox");
    expect(h.out.join("\n")).toContain("Inbox is empty");
    const state = await t.a.service.getState();
    expect(state.state.revisions[r1]!.status).toBe("saved");
    expect(state.state.revisions[r2]!.status).toBe("rejected");
    expect(state.state.revisions[r3]!.status).toBe("saved");
  });

  it("approve-relation and reject-relation work, and the inbox lists pending relations", async () => {
    const agent = { kind: "agent", name: "linker" };
    const mem = async (title: string) => ((await (await t.op("createMemory", { title })).json()) as { value: { id: string } }).value.id;
    const [m1, m2, m3] = [await mem("Rel A"), await mem("Rel B"), await mem("Rel C")];
    const link = async (to: string, label: string) =>
      ((await (await t.op("addRelation", { fromId: m1, toId: to, label, actor: agent })).json()) as { value: { id: string } }).value.id;
    const ra = await link(m2, "supports");
    const rb = await link(m3, "contradicts");
    const h = await cli();
    expect(await h.run("inbox")).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(ra);
    expect(text).toContain(rb);
    expect(text).toContain("supports");
    expect(await h.run("approve-relation", ra)).toBe(0);
    expect(await h.run("reject-relation", rb)).toBe(0);
    expect(h.out.join("\n")).toMatch(/Relation \S+ approved\./);
    expect(h.out.join("\n")).toMatch(/Relation \S+ rejected\./);
    const st = (await t.a.service.getState()).state;
    expect(st.relations[ra]!.status).toBe("saved");
    expect(st.relations[rb]!.status).toBe("rejected");
    expect(await h.run("approve-relation", "nope")).toBe(1);
    expect(h.err.join("")).toMatch(/not_found/);
  });

  it("prints server errors cleanly as code: message", async () => {
    const h = await cli();
    expect(await h.run("approve", "does-not-exist")).toBe(1);
    expect(h.err.join("")).toMatch(/^revision_not_found: /);
    expect(h.text()).not.toContain(t.a.session);
    expect(h.text()).not.toMatch(/\n\s+at /);
  });

  it("an invalid session asks for login without echoing it", async () => {
    saveSession(sess({ token: `ms_${"Z".repeat(43)}`, apiUrl: t.url }), home);
    const h = harness({ env: { MNEMONIS_API_URL: t.url } });
    expect(await h.run("me")).toBe(1);
    expect(h.err.join("")).toMatch(/login/);
    expect(h.text()).not.toContain("Z".repeat(43));
  });

  it("login against the real server stores a working session; logout revokes it", async () => {
    const h = harness({ env: { MNEMONIS_API_URL: t.url }, askPassword: async () => t.a.password });
    expect(await h.run("login", "--email", t.a.email)).toBe(0);
    const stored = loadSession(home)!;
    expect(stored.token).toMatch(/^ms_/);
    expect(await h.run("me")).toBe(0);
    expect(h.out.join("\n")).toContain(t.a.email);
    expect(await h.run("logout")).toBe(0);
    expect(h.out.join("\n")).toMatch(/revoked on the server/);
    expect((await fetch(`${t.url}/api/state`, { headers: { Authorization: `Bearer ${stored.token}` } })).status).toBe(401);
    const bad = harness({ env: { MNEMONIS_API_URL: t.url }, askPassword: async () => "not-the-password-1" });
    expect(await bad.run("login", "--email", t.a.email)).toBe(1);
    expect(bad.err.join("")).toContain("Invalid email or password");
  });
});

describe("output hygiene and token states against a mock API", () => {
  const ESC = "\u001b[2J\u001b]0;pwn\u0007";
  const BIDI = "\u202eevil\u2066x\u200b";
  const dirty = (s: string) => s.split("\n").some((l) => hasUnsafeChars(l));
  const hostile = (req: IncomingMessage, res: ServerResponse) => {
    const u = req.url ?? "";
    if (u === "/api/me") return json(res, { id: `id${ESC}`, email: `e${BIDI}`, displayName: `d${ESC}` });
    if (u === "/api/tokens" && req.method === "GET") {
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      return json(res, {
        tokens: [
          { id: `t1${ESC}`, label: `lab${BIDI}`, prefix: `mn_${ESC}`, createdAt: past, expiresAt: past, revokedAt: null },
          { id: "t2", label: "live", prefix: "mn_live", createdAt: past, expiresAt: future, revokedAt: null },
          { id: "t3", label: "gone", prefix: "mn_gone", createdAt: past, expiresAt: future, revokedAt: past },
          { id: "t4", label: "forever", prefix: "mn_inf", createdAt: past, expiresAt: null, revokedAt: null },
        ],
      });
    }
    if (u === "/api/tokens" && req.method === "POST") return json(res, { id: `id${ESC}`, token: "mn_good-Token_123", expiresAt: null });
    if (u === "/api/state") {
      const rev = { id: `rv${ESC}`, memoryId: "m1", status: "pending", origin: "agent", author: `au${BIDI}`, createdAt: "2026-01-01T00:00:00.000Z", note: "", kind: "create", snapshot: { title: `ti${ESC}` } };
      const rel = { id: `rl${ESC}`, fromId: "m1", toId: "m-unknown", label: `la${BIDI}`, status: "pending", provenance: { origin: "process", createdBy: "u", process: `pr${ESC}` }, createdAt: "2026-01-01T00:00:00.000Z" };
      return json(res, { state: { memories: { m1: { id: "m1" } }, revisions: { [rev.id]: rev }, relations: { [rel.id]: rel }, collections: {} } });
    }
    if (u === "/api/ops/approveAll") return json(res, { value: { approvedRevisionIds: [] } }); // not an array
    if (u.startsWith("/api/ops/")) return json(res, { value: null });
    if (req.method === "DELETE") return void res.writeHead(204).end();
    json(res, { error: { code: "x", message: "y" } }, 404);
  };
  let api: MockApi;
  beforeAll(async () => {
    api = await mockApi(hostile);
  });
  afterAll(() => api.close());
  const go = () => {
    saveSession(sess({ apiUrl: api.url }), home);
    return harness({ env: { MNEMONIS_API_URL: api.url } });
  };

  it("sanitizes everything the server supplies", async () => {
    const h = go();
    for (const argv of [["me"], ["tokens", "list"], ["tokens", "create", "l"], ["inbox"], ["approve-all", "--yes"], ["tokens", "revoke", `x${ESC}`], ["approve", `x${BIDI}`]]) {
      expect(await h.run(...argv)).toBe(0);
    }
    const all = [...h.out, ...h.err].join("\n");
    expect(dirty(all)).toBe(false);
    expect(all).toMatch(/lab/);
    expect(all).toMatch(/rv/);
    // the unknown-memory fallback id and all fields were printed, but cleaned
    expect(all).toContain("m-unknown");
  });
  it("lists active, expired and revoked tokens", async () => {
    const h = go();
    expect(await h.run("tokens", "list")).toBe(0);
    const line = (id: string) => h.out.find((l) => l.startsWith(id))!;
    expect(line("t1")).toMatch(/expired/);
    expect(line("t2")).toMatch(/active/);
    expect(line("t3")).toMatch(/revoked/);
    expect(line("t4")).toMatch(/active/);
  });
  it("tolerates a non-array approveAll value", async () => {
    const h = go();
    expect(await h.run("approve-all", "--yes")).toBe(0);
    expect(h.err).toEqual([]);
  });
  it("refuses and never prints a malformed token", async () => {
    try {
      for (const token of ["mn_bad token\u001b[31m", "xx_abc", "mn_", "mn_a\nb", 5]) {
        const srv = await mockApi((_q, res) => json(res, { id: "i", token, expiresAt: null }));
        try {
          saveSession(sess({ apiUrl: srv.url }), home);
          const h = harness({ env: { MNEMONIS_API_URL: srv.url } });
          expect(await h.run("tokens", "create", "l")).toBe(1);
          expect(h.out).toEqual([]);
          expect(h.err.join("")).toMatch(/malformed token/);
          expect(h.err.join("")).not.toContain(String(token));
        } finally {
          await srv.close();
        }
      }
    } finally {
      /* each server is closed above */
    }
  });
});
