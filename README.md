# Mnemonis API

The server of the Mnemonis memory system. It owns accounts, login sessions (`ms_...`), MCP tokens (`mn_...`), the PostgreSQL database (one workspace per user), the domain rules and every guard (agent actor, Inbox cap, rate limits, quotas). It is one of **three separate projects**:

| Project | What it is | Port | Talks to |
| --- | --- | --- | --- |
| `mnemonis` (web app) | React UI where the human signs in, reviews the Inbox and creates MCP tokens | 5173 (Vite dev) | this API only, with an `ms_` session |
| **`mnemonis_api` (this repo)** | accounts, sessions, MCP tokens, Postgres, domain, REST `/api/*`, internal agent API `/api/agent/*`, audit, operator CLI | **8787** | PostgreSQL |
| `mnemonis_mcp` | thin, stateless **MCP adapter** (`POST /mcp`, the 11 tools). No database, no domain logic, no secrets | **8788** | this API's `/api/agent/*`, forwarding the caller's `mn_` token |

```
Browser -- mnemonis (:5173) --ms_ session--> mnemonis_api (:8787) --> PostgreSQL
Claude Code / MCP client --POST /mcp, Bearer mn_--> mnemonis_mcp (:8788) --HTTP, mn_ forwarded--> /api/agent/* (mn_ only)
```

The user's `claude mcp add` URL points at the **adapter** (`http://localhost:8788/mcp`); the `mn_` token is created in the web app against this API. The adapter decides nothing about who may do what: every request is authorised by this API.

- **REST** (`/api/*`) for the web app (the human, who approves changes), authenticated with a **login session** (`ms_...`) from the server's own accounts (register / login, no external identity provider).
- **Internal agent API** (`/api/agent/*`) for the MCP adapter only, authenticated with an **`mn_` MCP token**. Agents can read memory and *propose* changes; every agent write lands in the Inbox as a **pending draft** that only the user can approve in the web app. Contract and fixtures: [Agent API](#agent-api-internal-for-the-mcp-adapter).
- `/mcp` is **gone from this server** (it answers `410` naming `MNEMONIS_MCP_URL`): MCP is served by `mnemonis_mcp`.

HTTP only (no stdio). Unauthenticated endpoints: `GET /api/health`, `GET /api/auth/config`, `GET /api/agent/contract`, `POST /api/auth/register`, `POST /api/auth/login`. The two credential types are never interchangeable: a session is refused on `/api/agent/*`, an `mn_` token is refused on every other `/api/*` route (including `/api/tokens`).

## Run all three locally

```bash
# 1. API + database (this repo)
cp .env.example .env            # set POSTGRES_PASSWORD, and the same password in DATABASE_URL / TEST_DATABASE_URL
set -a; . ./.env; set +a
npm install
npm run db:up && npm run db:migrate
npm run dev                     # API on http://127.0.0.1:8787  (or: docker compose up -d --build api)

# 2. MCP adapter (../mnemonis_mcp)
cd ../mnemonis_mcp && npm install
MNEMONIS_API_URL=http://127.0.0.1:8787 npm run dev     # adapter on http://127.0.0.1:8788/mcp (MCP_PORT to change)

# 3. Web app (../mnemonis)
cd ../mnemonis && npm install && npm run dev            # http://localhost:5173 -> VITE_API_URL (default http://localhost:8787)
```

Or let docker compose run the API, the database and the adapter: `docker compose --profile full up -d --build` (the web app still runs on the host). Then in the web app: register, open **MCP Connections**, create a token, and run the command it shows:

```bash
claude mcp add --transport http mnemonis http://localhost:8788/mcp --header "Authorization: Bearer mn_..."
```

## Setup and run (API only)

```bash
npm install
npm run db:up && npm run db:migrate   # LOCAL PostgreSQL via docker compose, then apply migrations (or set MNEMONIS_AUTO_MIGRATE=1)
npm run dev                           # tsx watch, or:  npm run build && npm start
```

Copy `.env.example` to `.env` (set `POSTGRES_PASSWORD`, and the same password in `DATABASE_URL` / `TEST_DATABASE_URL`) and load it into the shell (`set -a; . ./.env; set +a`).

**Remote-database guard.** `npm run dev`, `npm start`, `npm run db:migrate`, `npm run user` and every test/smoke pool refuse a `DATABASE_URL` whose host is not `localhost`, `127.0.0.1` or `::1` (or a unix socket), so a stray remote URL in `.env` is never migrated or written to by accident. To use a remote database on purpose, set `MNEMONIS_ALLOW_REMOTE_DB=true` explicitly in that command's environment. Point `TEST_DATABASE_URL` (tests, `npm run smoke`) only at a throw-away local database: the suite creates and deletes users, and its `globalSetup` applies pending migrations to it.

```bash
npm run smoke              # throw-away multi-user server (TEST_DATABASE_URL, local DB only): register/login, session REST, mcp token, /api/agent tools, surface separation
npm run user -- list       # operator CLI (see "Operator CLI: npm run user" below)
npm run sync-domain        # re-vendor src/domain from the web repo (../mnemonis)
npm run typecheck && npm run lint && npm test && npm run build
npm run contract:update    # regenerate contract/agent-v1/*.json after an intentional change of the agent API (then sync-contract in ../mnemonis_mcp)
```

### Create your first account (local)

With a loopback `HOST` (the default) registration is open. Register, then mint an MCP token from the session you get back (the web app does the same behind its Sign in page):

```bash
npm run dev    # or: npm run build && npm start
printf 'Password: '; read -rs PW; echo     # a long passphrase (12+ characters); not echoed, not in argv or shell history
printf '%s' "$PW" | node -e 'let p="";process.stdin.on("data",d=>p+=d).on("end",()=>process.stdout.write(JSON.stringify({email:process.argv[1],password:p})))' you@example.com \
  | curl -sS -X POST http://localhost:8787/api/auth/register -H 'Content-Type: application/json' --data-binary @-   # -> {"token":"ms_...","expiresAt":"...","user":{...}}
SESSION=ms_...                                                           # the token from the response
curl -sS -X POST http://localhost:8787/api/tokens -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -d '{"label":"claude-code"}'                                           # -> {"token":"mn_...",...}  (shown once)
claude mcp add --transport http mnemonis http://localhost:8788/mcp --header "Authorization: Bearer mn_..."   # the ADAPTER (mnemonis_mcp), not this server
```

Later: `POST /api/auth/login` with the same email and password returns a fresh session. Claude Code setup notes live in the `mnemonis_mcp` project (`docs/claude-code-setup.md`). Serve the API over **TLS** (https, e.g. behind a reverse proxy) whenever it is reachable beyond localhost: passwords and session tokens travel in the request.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `MNEMONIS_ALLOW_REGISTRATION` | `true` on loopback `HOST`, else `false` | Open self-registration. `true` on a non-loopback `HOST` requires an explicit `MNEMONIS_ALLOWED_ORIGINS` or the server refuses to start |
| `MNEMONIS_ALLOWED_EMAILS` | none (anyone) | Registration allowlist: `a@b.com` or `@domain.com` |
| `MNEMONIS_MAX_USERS` | `100` | Hard cap on accounts (registration closes at the cap) |
| `MNEMONIS_SESSION_IDLE_DAYS` / `MNEMONIS_SESSION_MAX_DAYS` | `7` / `30` | Sliding idle expiry and absolute maximum lifetime of a login session |
| `MNEMONIS_MAX_MCP_TOKENS` | `20` | Active MCP tokens per user |
| `MNEMONIS_MAX_WORKSPACE_BYTES` | `5242880` (5 MB) | Per-user cap on the serialized workspace. Enforced on every write path (REST ops, `PUT /api/state`, agent writes, operator import): `422 too_large` for ops / agent writes, `413 too_large` for the import. A write that does not grow the workspace is always allowed, so a user over a lowered cap can still review and archive |
| `MNEMONIS_MAX_MEMORIES` | `5000` | Per-user cap on the number of memories (same enforcement and error) |
| `MNEMONIS_HASH_CONCURRENCY` | `2` | Concurrent scrypt hashes (1-16). Each occupies a libuv threadpool thread (4 by default), so the default leaves room for I/O. A full queue answers `503 busy` with `Retry-After: 5` |
| `MNEMONIS_ALLOW_REMOTE_DB` | unset | Must be `true` for a `DATABASE_URL` whose host is not localhost/127.0.0.1/::1 (see the guard above) |
| `MNEMONIS_AUTO_MIGRATE` | `false` | Run migrations on start (otherwise run `npm run db:migrate`) |
| `MNEMONIS_MCP_URL` | `http://localhost:8788/mcp` | The MCP adapter URL published by `GET /api/auth/config` (the web app shows it in the `claude mcp add` command) and named by the `/mcp` 410. `https`, or `http` on localhost; path `/mcp`; no credentials, query or fragment (the server refuses to start otherwise) |
| `MNEMONIS_MAX_PENDING` | `200` | Inbox cap: unreviewed agent changes per user (`429 inbox_full`) |
| `MNEMONIS_AGENT_WRITES_PER_MINUTE` | `60` | Agent writes per minute per user, shared by all of the user's tokens (`429 rate_limited`) |
| `MNEMONIS_AGENT_READS_PER_MINUTE` | `300` | Agent reads per minute per user |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `MNEMONIS_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed by CORS (exact match, never `*`) |
| `MNEMONIS_ALLOWED_HOSTS` | none | Extra exact `Host` header values accepted besides loopback with the port. Must include the `host:port` the MCP adapter uses to reach this API (for example `api:8787` in docker compose) |
| `MNEMONIS_TRUST_PROXY` | `false` | The rate limiters, the login throttle and the audit IP bucket read `X-Forwarded-For` (its LAST entry, appended by your proxy, and only if it is a valid IP; otherwise the socket address is used; IPv6 is bucketed by /64). Enable only behind a trusted proxy that is the sole way to reach the app; otherwise clients can spoof it. With a non-loopback `HOST` and this unset the server prints a loud warning at start (it does not fail): behind a proxy every client would share one limiter bucket |

The human actor name on REST writes is the signed-in user's display name (`MNEMONIS_USER_NAME` and `MNEMONIS_DATA_DIR` are no longer used by the server).

## REST API

Errors are `{error: {code, message}}`; every `/api` response is `Cache-Control: no-store`. Sessions travel as `Authorization: Bearer ms_...` (no cookies, so no CSRF surface; CORS never allows credentials). Every credential refusal on `/api/*` (including `/api/agent/*`) is the same `401`.

Public (per-client rate limited, bodies up to 2 KB):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | exactly `{ok: true}`; no auth, no data |
| `GET /api/auth/config` | `{registrationOpen: boolean, mcpUrl: string \| null}` (nothing else; `mcpUrl` is `MNEMONIS_MCP_URL`) |
| `POST /api/auth/register` | `{email, password, displayName?}` -> `201 {token, expiresAt, user: {id, email, displayName}}`. 400 `invalid_input` (password policy / email), 403 `registration_closed` (closed, not on the allowlist, or at `MNEMONIS_MAX_USERS`), 409 `email_taken` |
| `POST /api/auth/login` | `{email, password}` -> `200` (same body). Unknown email and wrong password are the same byte-identical `401 invalid_credentials`. 5 failures lock the account for 1 minute, doubling to 15 (`429 rate_limited` + `Retry-After`) |

Session (`Authorization: Bearer ms_...`):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/me` (alias `/api/me`) | `{id, email, displayName, session: {expiresAt}}` |
| `POST /api/auth/logout` | revokes this session (204) |
| `POST /api/auth/password` | `{currentPassword, newPassword}` -> 204; revokes all OTHER sessions; wrong current password is `403 invalid_password` |
| `DELETE /api/auth/me` | `{password}` -> 204; deletes the account, workspace, sessions and tokens |
| `POST /api/tokens` | `{label, expiresInDays?}` creates an MCP token; `201 {id, token, prefix, label, createdAt, expiresAt}`; the token is shown once. 409 `token_limit_reached` at the per-user cap |
| `GET /api/tokens` | The user's MCP tokens (no secrets) |
| `DELETE /api/tokens/:id` | Revoke (204; 404 for unknown or someone else's) |
| `GET /api/state` | `{rev, state}`; `ETag: "<rev>"`; honours `If-None-Match` (304) |
| `PUT /api/state` | Import/replace from exported JSON. Requires `If-Match: "<rev>"` (428 if missing, 409 if stale). Up to 10 MB |
| `GET /api/export` | Pretty JSON export |
| `POST /api/ops/:name` | One mutation; the JSON body is the argument object; returns `{rev, state, value}` |

Passwords: 12+ characters, at most 128 bytes, no composition rules, a small list of very common passwords is refused, and so is a password equal to the email's local part. Hashing is scrypt (N=2^15, r=8, p=1, 16-byte salt) with a bounded concurrency queue (`503 busy` when saturated). Sessions are opaque `ms_` tokens stored as SHA-256, idle expiry 7 days (sliding), absolute 30 days, at most 10 active per user. Emails are not verified; registering an existing email answers `409`.

Ops (same names and arguments as the web `MemoryRepository`, plus an optional agent `actor` on write ops, see below): `createMemory`, `updateMemory`, `archiveMemory`, `restoreMemory`, `rollbackMemory`, `addRelation`, `removeRelation`, `createCollection`, `updateCollection`, `deleteCollection`, `approve`, `reject`, `approveRelation`, `rejectRelation`, `approveAll`, `rejectAll`, `approveAllDetailed`, `rejectAllDetailed`. Anything else is 404. Bodies are validated with strict schemas (unknown keys: 400) and limited to 1 MB (413).

The actor is the server-side human user, with one **downgrade-only** exception. For the memory/relation write ops (`createMemory`, `updateMemory`, `archiveMemory`, `restoreMemory`, `rollbackMemory`, `addRelation`) the body may carry `"actor": {"kind": "agent", "name": "<1..100 chars, no control characters>"}` (validated with the domain's `assertActor`); the write then runs as that agent and lands **pending** in the Inbox (used by the web app's rule-based Memory Health checks). Any other `actor` (kind `user`, missing, malformed) is silently ignored and the server user is used: a body can never upgrade or impersonate the user. Review ops (`approve`, `reject`, `approveRelation`, `rejectRelation`, `approveAll`, `rejectAll`, the `Detailed` variants) and `removeRelation` always run as the server user; an `actor` in their body is ignored (not rejected). Collection ops ignore it too. The audit log records the effective `actorKind` and name.

Errors: `{error: {code, message}}` with 400 `invalid_input`, 404 `*_not_found`, 403 `forbidden`, 409 (`not_pending`, `proposal_outdated`, `duplicate_*`, `collection_not_empty`, `endpoint_not_saved`, `not_saved`, `memory_archived`, `conflict`), 422 `too_large`, 429 `rate_limited`/`inbox_full`, 500 `internal` (never a stack trace or file path).

## Command-line client (`npm run cli`)

`npm run cli -- <command>` talks to a running server's REST API with your login session. It reads only `MNEMONIS_API_URL` (from the environment, falling back to `.env`); nothing else in `.env` (such as `DATABASE_URL`) is loaded. `MNEMONIS_API_URL` (default `http://127.0.0.1:8787`) must be `https`, or `http` for localhost / 127.0.0.0/8 / `::1`, with no credentials, query or fragment; it is checked before any prompt or request. Requests refuse redirects and time out after 15 s.

The stored session is bound to the `MNEMONIS_API_URL` it was issued for; if it changes, run `login` again. The session directory must be a real directory you own, and the file is refused unless it is a regular file owned by you with mode `0600`.

| Command | Does |
| --- | --- |
| `login [--email <e>]` | Password is read from a hidden prompt (never from arguments) and sent to `POST /api/auth/login`. Only the session token (not the password) is stored in `~/.mnemonis/cli-session.json` (dir `0700`, file `0600`) |
| `logout` | Revokes the session on the server (best effort), then deletes the file; it says whether the session was revoked or only deleted locally |
| `me` | Show id, email, display name |
| `tokens list` / `tokens create <label> [--days N]` / `tokens revoke <id>` | Manage MCP tokens (`--days` 1-365). `create` prints the `mn_` token exactly once, inside the `claude mcp add` line. That token is long-lived and, once pasted, lands in your shell history and process arguments, so clear it from history and revoke it if it leaks |
| `inbox` | List every pending revision (any origin, tagged) and relation: exactly the set `approve-all` would approve |
| `approve <revisionId>` / `reject <revisionId>` / `approve-relation <id>` / `reject-relation <id>` / `approve-all [--yes]` | Review proposals. `approve-all` shows the pending count (including items not proposed by an agent) and needs `--yes` or a `y` at an interactive prompt; without a TTY it fails unless `--yes` is given |
| `health` | Check the server |

## Operator CLI: `npm run user`

Run on the server machine only. It talks to the database directly with `DATABASE_URL` (which must pass the local/remote guard), exposes nothing over HTTP, and is separate from the end-user client above. Every state change writes an audit row (`via: operator`, action names and outcomes only: never passwords, hashes or workspace content). The forgotten-password flow is: the operator resets it here and gives the user the temporary password out of band.

```bash
npm run user -- list                                  # id, email, createdAt, disabled, hasPassword (never a hash)
npm run user -- reset you@example.com                 # hidden prompt twice (needs a TTY; never read from args or pipes)
npm run user -- reset you@example.com --generate      # prints a one-time temporary password on stdout (notices on stderr)
npm run user -- reset you@example.com --revoke-tokens # also revokes the user's MCP tokens
npm run user -- disable you@example.com               # block sign-in, revoke all sessions (MCP tokens stop while disabled)
npm run user -- enable you@example.com
npm run user -- unlock you@example.com                # clear the login lockout / failure counters
npm run user -- import-file you@example.com           # legacy ~/.mnemonis/workspace.json (or pass a path)
npm run user -- import-file you@example.com ./workspace.json --force
```

- `reset` sets the password (policy applies to a typed one), revokes **all** sessions, clears the lockout, failure counters and trusted-IP records. Users created before accounts existed (no password hash) are recovered the same way.
- `import-file` validates the file with the domain's migrator, refuses unless the user's workspace is empty at revision 0 (or `--force` replaces it), applies the per-user quotas, prints counts only, and never modifies, moves or deletes the source file. The old single-user `workspace.json` and token are not adopted automatically.

## Agent API (internal, for the MCP adapter)

`/api/agent/*` is the only surface `mn_` tokens can use, and the only caller meant to use it is the `mnemonis_mcp` adapter. **Do not route it through a public ingress**: anyone holding a valid `mn_` token could call it directly (the same privilege they already have through the adapter, but they could also spoof `X-Mnemonis-Client` / `X-Forwarded-For`). It is registered before the session middleware, refuses any request that carries an `Origin` header (403, no CORS headers) and accepts no `ms_` session.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agent/ping` | `{ok: true, contract: 1}` for a valid token (the adapter's per-request preflight) |
| `GET /api/agent/contract` | public, rate limited: `{contract: "mnemonis-agent", version: 1, minSupported: 1, tools: [...]}` |
| `POST /api/agent/memory/{search,read,list,related,history,status,diff}` | reads (saved memory only) |
| `POST /api/agent/memory/{save,update,link,archive}` | writes: always a **pending** proposal as an **agent** actor |

Rules: header `X-Mnemonis-Contract: 1` is required (`426 contract_unsupported`), `Content-Type: application/json` (`415`), bodies are strict (unknown keys such as `actor`, `origin`, `source`, `provenance` are `400 invalid_input`) and at most 512 KiB (`413`). `X-Mnemonis-Client` (optional, printable ASCII, at most 100 characters) names the agent in the audit log and as the proposal author; `X-Request-Id` (8-64 of `A-Za-z0-9._-`) is echoed. Success is `200` with the tool's data object; errors are `{error: {code, message}}`: `400 invalid_input`, `401 unauthorized` (`WWW-Authenticate: Bearer realm="mnemonis"`), `404 *_not_found`, `409 conflict | not_pending | ...`, `422 too_large`, `429 rate_limited` (+ `Retry-After`) / `inbox_full`, `429 too_many_failed_attempts` (+ `Retry-After`, the pre-auth failure limiter of this surface), `500 internal`. Reads are limited per user (`MNEMONIS_AGENT_READS_PER_MINUTE`), writes per user (`MNEMONIS_AGENT_WRITES_PER_MINUTE`) and by the Inbox cap (`MNEMONIS_MAX_PENDING`).

The contract is pinned by fixtures in [`contract/agent-v1/`](contract/agent-v1) (one request + response example per endpoint, `limits.json`, the error table). `npm test` fails when the API drifts from them; after an intentional change run `npm run contract:update`, commit, and re-vendor them in `mnemonis_mcp` (`npm run sync-contract`). Bump `AGENT_CONTRACT_VERSION` only for breaking changes.

Reads return saved memory only. A memory that has never been approved is not listed or searchable, and `memory_read` shows only proposal metadata for it. The tool descriptions, the untrusted-content `notice` and the MCP protocol live in the adapter.

## Hosting notes

- Set `DATABASE_URL` (operator-side, never committed) to the Postgres connection string of the database owner role, then run `npm run db:migrate`.
- Migrations `0002_enable_rls.sql`, `0003_accounts.sql` and `0004_login_throttle.sql` turn on Row-Level Security with no policies for every table (`users`, `workspaces`, `api_tokens`, `sessions`, `login_throttle`, `known_login_ips`, `audit_log`, `schema_migrations`), so a hosted Postgres' public Data API roles cannot read or write them. The server connects as the table owner, which bypasses RLS (`FORCE` is deliberately not used; it would lock the owner out).
- Put the server behind TLS. Set `MNEMONIS_ALLOWED_ORIGINS` to your web app's origin, `MNEMONIS_ALLOWED_HOSTS` to your API host, and decide whether registration stays open (`MNEMONIS_ALLOW_REGISTRATION`, `MNEMONIS_ALLOWED_EMAILS`, `MNEMONIS_MAX_USERS`).
- If the database password was ever shared or pasted anywhere, rotate it and update `DATABASE_URL`.

## Security model

- **Host check**: the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the server's port, or an exact (case-insensitive) match of `MNEMONIS_ALLOWED_HOSTS` (DNS-rebinding defence), on every route including `/api/agent/*`.
- **Origin check**: requests carrying an `Origin` header (browsers) must match `MNEMONIS_ALLOWED_ORIGINS` exactly, otherwise 403; `/api/agent/*` refuses every request with an `Origin`. CORS preflights answer 204 only for allowed origins; allowed methods are `GET, POST, PUT, DELETE, OPTIONS`.
- **Credentials**: the credential shape picks the verifier (`ms_` session for `/api/*`, `mn_` token for `/api/agent/*`); the two are never tried in turn and neither is accepted on the other surface. Sessions and tokens are stored as SHA-256 hashes, shown once, and revocation takes effect on the next request. Database failures during authentication give `503`, not `401`. Repeated failed authentication from one client gets `429`.
- **Passwords and login**: scrypt hashes (the dummy hash is warmed at start, and a corrupt stored hash costs the same work, so there is no timing signal), byte-identical 401s for wrong password / unknown email / oversize password, per-client attempt limits on login/register, and a bounded hashing queue.
- **Login throttling** (tables `login_throttle`, `known_login_ips`; state is persisted, so it survives restarts, and unknown emails use the very same rows, keyed by `sha256(email)`, so there is no existence signal): a *strict* lock on (email, client IP bucket) of 60 s doubling to 900 s after 5 failures, which only ever affects the client that produced the failures; and a *soft* lock on the email alone (10 failures from any clients, a fixed 60 s, never escalated, counter decays after 15 quiet minutes) that a correct password from a **known-good IP bucket** (a successful login to that account within 30 days; at most 20 per user, stored only as per-user-salted hashes, cleared on password change/reset) is NOT refused by. Re-authentication (change password, delete account) has its own persisted per-user backoff. Residual risk: someone who knows an email and can spread guesses over many addresses can keep *new-location* sign-ins to that account failing for about a minute at a time (with ~10 bad logins per minute); the owner's usual locations, and sessions already open, are unaffected, and the operator can `unlock`. With `MNEMONIS_TRUST_PROXY` unset behind a proxy all clients share one IP bucket, so set it correctly. A stolen password used from a previously known IP is not slowed by the soft lock (the strict lock and password strength remain the defence).
- **Housekeeping**: a bounded job (every 10 minutes, and opportunistically at login) deletes expired throttle rows (the table is also capped at 50 000 rows), known-IP rows past 30 days, and sessions past their absolute/idle expiry or revoked more than 7 days ago.
- **Per-user isolation**: every handler gets its user id only from the authenticated context; each user has a separate workspace, inbox cap and write rate limit (60 writes per minute per user, across all of that user's tokens).
- **Agents cannot commit memory**: agent writes go through a guard that forces an agent actor, so every write is a pending proposal. Limits: title 200 chars, content 50 000, 20 tags of 50 chars, metadata 8 KB, search query 500 chars, list limit 100, at most 200 unreviewed agent items in the Inbox, 60 writes per minute per user.
- **Prompt injection**: memory content is data. Tool descriptions and results say so, but a model can still be misled by hostile text, so the user stays the approval gate.
- **Audit**: the `audit_log` table records user, door, action and ids, never content, tokens or passwords; login failures store only an IP bucket, never the submitted email (best-effort, bounded queue).

## Layout

```
src/domain/    vendored pure domain code from the web repo (do not edit; npm run sync-domain)
src/store/     pgStore (multi-user Postgres, per-user quotas), importJson (validating import parser)
src/service/   memoryService + guards (the only things REST and the agent API call)
src/auth/      password (scrypt), email, sessions, throttle (persisted login throttling), maintenance (reaping), accounts (register/login/...), apiTokens
src/operator/  `npm run user` operator CLI (reset/disable/enable/unlock/list/import-file)
src/db/        pool, migrate, guard (local-only DATABASE_URL unless MNEMONIS_ALLOW_REMOTE_DB=true)
src/http/      Hono app: server, auth middleware (session / mcp token), authRoutes (public), rest, cors/host/origin guards
src/agent/     the internal /api/agent/* surface: schemas, handlers (the 11 tool bodies), routes
contract/      agent-v1 fixtures (generated by test/agentContract.test.ts, vendored by mnemonis_mcp)
src/audit.ts   Postgres audit trail
```
