import { createInterface } from "node:readline/promises";
import { validMcpUrl } from "../config.js";
import { pendingChanges, type Relation, type WorkspaceState } from "../domain/index.js";
import { ApiClient, sanitize } from "./client.js";
import { readHidden, type PromptIo } from "./prompt.js";
import { clearSession, loadSession, saveSession, sessionPaths } from "./session.js";
import { CliError, guardedFetch, parseOrigin, passwordLogin, remoteLogout } from "./http.js";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  home?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 15000); injectable for tests. */
  timeoutMs?: number;
  /** y/N confirmation; defaults to a TTY prompt and fails when stdin is not a TTY. */
  confirm?: (question: string) => Promise<boolean>;
  /** Hidden password prompt; defaults to a TTY prompt on stdin/stdout. */
  askPassword?: (question: string) => Promise<string>;
  /** Visible prompt for the email when --email is absent. */
  askLine?: (question: string) => Promise<string>;
  io?: PromptIo;
}

const USAGE = `Usage: npm run cli -- <command>
  login [--email <email>]        sign in to the server (password is prompted, never taken from arguments)
  logout                         revoke the session on the server (best effort) and delete the stored session
  me                             show the signed-in user
  tokens list                    list MCP tokens
  tokens create <label> [--days N]   (days 1-365)
  tokens revoke <id>
  inbox                          list pending proposals (exactly what approve-all would approve)
  approve <revisionId> | reject <revisionId>
  approve-relation <relationId> | reject-relation <relationId>
  approve-all [--yes]            approve everything in the inbox (asks for confirmation)
  health                         check the server`;

interface Parsed {
  positionals: string[];
  flags: Map<string, string>;
}

function parse(args: string[], valueFlags: string[], boolFlags: string[] = []): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (/pass/i.test(name)) throw new CliError("Passwords are never accepted as arguments; you will be prompted securely.");
      if (boolFlags.includes(name) && inline === undefined) {
        flags.set(name, "true");
        continue;
      }
      if (!valueFlags.includes(name)) throw new CliError(`Unknown option --${name}`);
      const v = inline ?? args[++i];
      if (v === undefined) throw new CliError(`--${name} needs a value`);
      flags.set(name, v);
    } else positionals.push(a);
  }
  return { positionals, flags };
}

const need = (p: Parsed, n: number, usage: string): string[] => {
  if (p.positionals.length !== n) throw new CliError(`Usage: ${usage}`);
  return p.positionals;
};

const when = (iso: string) => (Number.isNaN(Date.parse(iso)) ? sanitize(iso, 40) : new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z");
const enc = encodeURIComponent;

async function pending(client: ApiClient) {
  const { state } = await client.request<{ state: WorkspaceState }>("GET", "/api/state");
  const revs = pendingChanges(state);
  const rels = Object.values(state.relations).filter((r: Relation) => r.status === "pending");
  return { state, revs, rels };
}

async function askYesNo(question: string, io: PromptIo): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { out } = deps;
  try {
    const [cmd, ...rest] = argv;
    if (cmd === undefined || cmd === "help" || cmd === "--help") {
      (cmd === undefined ? deps.err : out)(USAGE);
      return cmd === undefined ? 1 : 0;
    }
    // Validate hosts before any prompt or network access.
    const apiUrl = parseOrigin("MNEMONIS_API_URL", deps.env.MNEMONIS_API_URL?.trim() || "http://127.0.0.1:8787");
    const f = guardedFetch(deps.fetch, deps.timeoutMs);
    const client = new ApiClient({ apiUrl, home: deps.home, fetch: f });
    const io: PromptIo = deps.io ?? { input: process.stdin, output: process.stdout };
    const post = (op: string, body: unknown) => client.request<{ value: unknown }>("POST", `/api/ops/${op}`, body);

    switch (cmd) {
      case "login": {
        const p = parse(rest, ["email"]);
        need(p, 0, "login [--email <email>]");
        let email = p.flags.get("email");
        if (!email) {
          if (deps.askLine) email = await deps.askLine("Email: ");
          else {
            const rl = createInterface({ input: io.input, output: io.output });
            try {
              email = await rl.question("Email: ");
            } finally {
              rl.close();
            }
          }
        }
        email = email.trim();
        if (!email) throw new CliError("An email is required.");
        const password = await (deps.askPassword ?? ((q) => readHidden(q, io)))("Password: ");
        if (!password) throw new CliError("A password is required.");
        saveSession(await passwordLogin(apiUrl, email, password, f), deps.home);
        out(`Logged in. Session stored in ${sessionPaths(deps.home).file}`);
        return 0;
      }
      case "logout": {
        need(parse(rest, []), 0, "logout");
        let s = null;
        try {
          s = loadSession(deps.home);
        } catch {
          /* unsafe or unreadable file: still delete it locally below */
        }
        let remote = false;
        if (s) remote = s.apiUrl === apiUrl ? await remoteLogout(apiUrl, s.token, f) : false;
        const had = clearSession(deps.home);
        if (!had && !s) out("No stored session.");
        else if (remote) out("Logged out: session revoked on the server and the local session file deleted.");
        else out("Local session file deleted only; NOT revoked on the server (unreachable, expired, or a different MNEMONIS_API_URL). It stays valid there until it expires or you log out elsewhere.");
        return 0;
      }
      case "health": {
        need(parse(rest, []), 0, "health");
        const h = (await client.health()) as { ok?: boolean };
        out(h.ok ? `OK (${apiUrl})` : "Server responded but is not healthy.");
        return h.ok ? 0 : 1;
      }
      case "me": {
        need(parse(rest, []), 0, "me");
        const me = await client.request<{ id: string; email: string; displayName: string }>("GET", "/api/me");
        out(`id:          ${sanitize(me.id)}\nemail:       ${sanitize(me.email)}\ndisplayName: ${sanitize(me.displayName)}`);
        return 0;
      }
      case "tokens": {
        const [sub, ...r2] = rest;
        if (sub === "list") {
          need(parse(r2, []), 0, "tokens list");
          const { tokens } = await client.request<{ tokens: { id: string; label: string; prefix: string; createdAt: string; expiresAt: string | null; revokedAt: string | null }[] }>("GET", "/api/tokens");
          if (!tokens.length) out("No tokens.");
          for (const t of tokens) {
            const state = t.revokedAt ? "revoked" : t.expiresAt && Date.parse(t.expiresAt) < Date.now() ? "expired" : "active";
            out(`${sanitize(t.id)}  ${sanitize(t.prefix, 40)}...  ${state.padEnd(7)}  ${sanitize(t.label, 100)}  created ${when(t.createdAt)}${t.expiresAt ? `  expires ${when(t.expiresAt)}` : ""}`);
          }
          return 0;
        }
        if (sub === "create") {
          const p = parse(r2, ["days"]);
          const [label] = need(p, 1, "tokens create <label> [--days N]");
          const days = p.flags.get("days");
          if (days !== undefined && (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 365)) throw new CliError("--days must be a whole number from 1 to 365");
          const t = await client.request<{ id: string; token: string; expiresAt: string | null }>("POST", "/api/tokens", {
            label,
            ...(days !== undefined ? { expiresInDays: Number(days) } : {}),
          });
          if (typeof t.token !== "string" || !/^mn_[A-Za-z0-9_-]+$/.test(t.token)) throw new CliError("The server returned a malformed token; it was not displayed. Revoke it with: tokens list / tokens revoke <id>");
          out(`Token ${sanitize(t.id, 80)} created${t.expiresAt ? ` (expires ${when(t.expiresAt)})` : ""}. The token appears ONCE, in the command below; it cannot be shown again.`);
          out("WARNING: the token is long-lived and, once pasted into this command, lands in your shell history and in process arguments. Clear it from history, and revoke it with `tokens revoke` if it leaks.");
          // The MCP adapter's URL is published by the server (GET /api/auth/config); it is shown only if it passes the same check the server applies.
          const cfg = await client.request<{ mcpUrl?: unknown }>("GET", "/api/auth/config").catch(() => ({ mcpUrl: null }));
          const mcpUrl = typeof cfg.mcpUrl === "string" && validMcpUrl(cfg.mcpUrl) ? cfg.mcpUrl : "<MCP-ADAPTER-URL>";
          out(`claude mcp add --transport http mnemonis ${mcpUrl} --header "Authorization: Bearer ${t.token}"`);
          return 0;
        }
        if (sub === "revoke") {
          const [id] = need(parse(r2, []), 1, "tokens revoke <id>");
          await client.request("DELETE", `/api/tokens/${enc(id!)}`);
          out(`Token ${sanitize(id!, 80)} revoked.`);
          return 0;
        }
        throw new CliError("Usage: tokens list | create <label> [--days N] | revoke <id>");
      }
      case "inbox": {
        need(parse(rest, []), 0, "inbox");
        const { revs, rels, state } = await pending(client);
        const titleOf = (memoryId: string) => {
          const t = Object.values(state.revisions).filter((r) => r.memoryId === memoryId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]?.snapshot.title;
          return sanitize(t || memoryId, 60);
        };
        if (!revs.length && !rels.length) out("Inbox is empty.");
        else out(`Pending: ${revs.length} revision(s), ${rels.length} relation(s) (all origins; approve-all acts on exactly this list).`);
        for (const r of revs) out(`revision ${sanitize(r.revisionId)}  [${sanitize(r.origin, 20)}]  "${sanitize(r.title, 80)}"  by ${sanitize(r.author, 100)}  ${when(r.createdAt)}`);
        for (const r of rels) {
          out(`relation ${sanitize(r.id)}  "${titleOf(r.fromId)}" -[${sanitize(r.label, 60)}]-> "${titleOf(r.toId)}"  by ${sanitize(r.provenance.process ?? r.provenance.createdBy, 100)}  ${when(r.createdAt)}`);
        }
        return 0;
      }
      case "approve":
      case "reject": {
        const [revisionId] = need(parse(rest, []), 1, `${cmd} <revisionId>`);
        await post(cmd, { revisionId });
        out(`Revision ${sanitize(revisionId!, 80)} ${cmd === "approve" ? "approved" : "rejected"}.`);
        return 0;
      }
      case "approve-relation":
      case "reject-relation": {
        const [relationId] = need(parse(rest, []), 1, `${cmd} <relationId>`);
        await post(cmd === "approve-relation" ? "approveRelation" : "rejectRelation", { relationId });
        out(`Relation ${sanitize(relationId!, 80)} ${cmd === "approve-relation" ? "approved" : "rejected"}.`);
        return 0;
      }
      case "approve-all": {
        const p = parse(rest, [], ["yes"]);
        need(p, 0, "approve-all [--yes]");
        const { revs, rels } = await pending(client);
        if (!revs.length && !rels.length) {
          out("Nothing pending.");
          return 0;
        }
        const nonAgent = revs.filter((r) => r.origin !== "agent").length + rels.filter((r) => r.provenance.origin !== "process").length;
        const summary = `${revs.length} revision(s) and ${rels.length} relation(s) are pending${nonAgent ? ` (${nonAgent} not proposed by an agent)` : ""}.`;
        if (!p.flags.has("yes")) {
          const ask = deps.confirm ?? (io.input.isTTY ? (q: string) => askYesNo(q, io) : undefined);
          if (!ask) throw new CliError(`${summary} Not a terminal: pass --yes to approve without a prompt.`);
          if (!(await ask(`${summary} Approve all? [y/N] `))) {
            out("Cancelled; nothing approved.");
            return 1;
          }
        } else out(summary);
        // Approve exactly the items that were listed, not whatever became pending since.
        const r = await post("approveAll", { revisionIds: revs.map((x) => x.revisionId), relationIds: rels.map((x) => x.id) });
        out(Array.isArray(r.value) ? `Approved ${r.value.length} revision(s) (relations: up to ${rels.length}).` : "Approved all listed items.");
        return 0;
      }
      default:
        deps.err(`Unknown command: ${sanitize(cmd, 40)}\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    deps.err(e instanceof CliError ? e.message : e instanceof Error && !/\n\s+at /.test(e.message) ? `Error: ${sanitize(e.message)}` : "Unexpected error.");
    return 1;
  }
}
