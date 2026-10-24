import { isLoopbackHost, proxyWarnings, type Config } from "./config.js";

/**
 * The curl example that registers an account WITHOUT putting the password in argv (visible in `ps` and shell history):
 * it is read silently with `read -rs` and piped on stdin to a JSON encoder, then to curl's --data-binary @-.
 */
export function registerExample(port: number): string[] {
  return [
    `  printf 'Password: '; read -rs PW; echo`,
    `  printf '%s' "$PW" | node -e 'let p="";process.stdin.on("data",d=>p+=d).on("end",()=>process.stdout.write(JSON.stringify({email:process.argv[1],password:p})))' you@example.com \\`,
    `    | curl -sS -X POST http://localhost:${port}/api/auth/register -H "Content-Type: application/json" --data-binary @-`,
  ];
}

export interface Banner {
  warnings: string[];
  lines: string[];
}

export function startupBanner(cfg: Config, port: number): Banner {
  const warnings = proxyWarnings(cfg);
  if (!isLoopbackHost(cfg.host)) warnings.push("Serve this over TLS (https) behind a reverse proxy: passwords and session tokens travel in HTTP headers/bodies.");
  const lines = [
    `Mnemonis API server listening on http://${cfg.host}:${port}`,
    `  REST: http://localhost:${port}/api/state   Agent API (for the MCP adapter only): http://localhost:${port}/api/agent/`,
    `  MCP adapter (separate project, mnemonis_mcp): ${cfg.mcpUrl ?? "not configured"}`,
    `  Registration: ${cfg.allowRegistration ? `open (max ${cfg.maxUsers} users${cfg.allowedEmails.length ? ", email allowlist on" : ""})` : "closed"}`,
    "\nCreate your account from the web app, or from a shell without putting the password in the command line:",
    ...registerExample(port),
    "Then create an MCP token (shown once) with the session token from that response:",
    `  curl -sS -X POST http://localhost:${port}/api/tokens -H "Authorization: Bearer ms_..." -H "Content-Type: application/json" -d '{"label":"claude-code"}'`,
    `  claude mcp add --transport http mnemonis ${cfg.mcpUrl ?? "<MCP-ADAPTER-URL>"} --header "Authorization: Bearer mn_..."\n`,
    "Forgot a password? On the server machine: npm run user -- reset <email> (see the README).\n",
  ];
  return { warnings, lines };
}
