import { createAccountService } from "./auth/accounts.js";
import { startMaintenance } from "./auth/maintenance.js";
import { startupBanner } from "./banner.js";
import { createPgAudit } from "./audit.js";
import { ConfigError, parseConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { parseAllowedOrigins } from "./http/cors.js";
import { startHttpServer } from "./http/server.js";
import { createRateLimiter } from "./service/guards.js";
import { createMemoryServices } from "./service/memoryService.js";
import { shutdown } from "./shutdown.js";
import { PgStore } from "./store/pgStore.js";

async function main(): Promise<void> {
  const cfg = parseConfig();
  const pool = createPool({ connectionString: cfg.databaseUrl });
  const audit = createPgAudit(pool);

  let server;
  try {
    if (cfg.autoMigrate) {
      const applied = await migrate(pool);
      if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
    } else {
      console.log("  Database schema is not migrated automatically: run `npm run db:migrate` (or set MNEMONIS_AUTO_MIGRATE=1).");
    }
    const store = new PgStore(pool, { maxWorkspaceBytes: cfg.maxWorkspaceBytes, maxMemories: cfg.maxMemories });
    server = await startHttpServer({
      services: createMemoryServices({ store }),
      audit,
      accounts: createAccountService(pool, store, cfg),
      allowedOrigins: parseAllowedOrigins(cfg.allowedOrigins.join(",")),
      allowedHosts: cfg.allowedHosts,
      trustProxy: cfg.trustProxy,
      adapterSecret: cfg.adapterSecret,
      limiter: createRateLimiter({ max: cfg.agentWritesPerMinute }),
      readLimiter: createRateLimiter({ max: cfg.agentReadsPerMinute, noun: "reads" }),
      maxPending: cfg.maxPending,
      mcpUrl: cfg.mcpUrl,
      host: cfg.host,
      port: cfg.port,
    });
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }

  const banner = startupBanner(cfg, server.port);
  for (const w of banner.warnings) console.warn(`  WARNING: ${w}`);
  for (const l of banner.lines) console.log(l);
  const stopMaintenance = startMaintenance(pool, { idleDays: cfg.sessionIdleDays });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      console.log(`\n${signal} received again, forcing exit.`);
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${signal} received, shutting down (send it again to force exit)...`);
    void (async () => {
      try {
        stopMaintenance();
        await shutdown({ server, audit, pool });
      } catch {
        /* best effort */
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    console.error(`Cannot start: ${e.message}`);
  } else if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error("Cannot start: the port is already in use (set PORT to another value).");
  } else {
    // Driver errors can carry connection details; report the class only.
    console.error(`Cannot start: ${e instanceof Error ? (e.name === "Error" ? e.message : e.name) : "unknown error"}`);
  }
  process.exit(1);
});
