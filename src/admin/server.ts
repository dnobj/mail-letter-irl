import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AdminAuditWriter } from "./auditService.js";
import { closeAdminPools, createAdminPools, verifyDatabaseIdentity, type AdminPools } from "./db.js";
import { AdminConfigurationError, AdminFoundationError } from "./errors.js";
import { clientScriptPath, createAdminRequestListener, type RouteHandler } from "./http/app.js";
import { AdminRouter } from "./http/router.js";
import { NAV_ITEMS, registerReadRoutes } from "./http/routes.js";
import { AdminSessionStore, hashSessionId } from "./http/session.js";
import { parseAdminRuntimeConfig, type AdminRuntimeConfig } from "./runtimeConfig.js";
import { createTailscaleCli, createWhoisClient, spawnTailscaled, type WhoisClient } from "./tailscale/cli.js";
import { TailscaleSupervisor, refuseIfPublicDomain, type TailscaleNodeIdentity } from "./tailscale/daemon.js";
import { classifyDiagnosticError, writeDiagnostic } from "../utils/diagnosticLog.js";

/**
 * The admin service entrypoint. Boot order:
 *
 *   1. validate the Railway variables (names printed, values never);
 *   2. open the health listener on [::]:PORT, answering 503 until ready;
 *   3. in daemon mode, refuse a public domain, then bring the Tailscale
 *      node up and verify its tag and name;
 *   4. open the pools and verify role and marker for each;
 *   5. write the admin.boot audit event;
 *   6. open the application listener on 127.0.0.1:ADMIN_APP_PORT, which only
 *      the local Serve proxy can reach.
 *
 * Nothing here loads a .env file: on Railway the variables are injected, and
 * on a workstation `npm run admin:dev` supplies an explicit file.
 */

interface ReadyState {
  configured: boolean;
  tailscale: boolean;
  database: boolean;
  listening: boolean;
}

const BUILD_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown";

function startHealthListener(port: number, state: ReadyState, supervisor: TailscaleSupervisor | null): http.Server {
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("X-Build-Commit", BUILD_COMMIT);
    const path = (request.url ?? "/").split("?")[0];
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }
    if (path !== "/healthz") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const daemonHealthy = supervisor ? supervisor.isHealthy() : true;
    const ready = state.configured && state.tailscale && state.database && state.listening && daemonHealthy;
    response.statusCode = ready ? 200 : 503;
    response.end(ready ? "ok" : "unavailable");
  });
  server.listen(port, "::", () => {
    writeDiagnostic("info", "admin.health_listening", { port });
  });
  return server;
}

async function loadClientScript(): Promise<{ path: string; body: string }> {
  const scriptUrl = new URL("./ui/client.js", import.meta.url);
  const body = await readFile(fileURLToPath(scriptUrl), "utf8");
  return { path: clientScriptPath(body), body };
}

export async function main(): Promise<void> {
  let config: AdminRuntimeConfig;
  try {
    config = parseAdminRuntimeConfig(process.env);
  } catch (error) {
    if (error instanceof AdminConfigurationError) {
      for (const problem of error.problems) console.error(`[admin] configuration: ${problem}`);
    }
    throw error;
  }
  const state: ReadyState = { configured: true, tailscale: false, database: false, listening: false };

  let supervisor: TailscaleSupervisor | null = null;
  let identity: TailscaleNodeIdentity | null = null;
  let whois: WhoisClient;
  let closing = false;

  if (config.tailscale.mode === "daemon") {
    refuseIfPublicDomain(process.env);
    const cli = createTailscaleCli(config.tailscale.socketPath);
    supervisor = new TailscaleSupervisor({
      hostname: config.tailscale.hostname,
      tag: config.tailscale.tag,
      stateFile: config.tailscale.stateFile,
      socketPath: config.tailscale.socketPath,
      appPort: config.appPort,
      authKey: config.tailscale.authKey,
      spawnDaemon: () =>
        spawnTailscaled({
          stateFile: config.tailscale.stateFile,
          socketPath: config.tailscale.socketPath,
        }),
      cli,
    });
    whois = createWhoisClient(cli);
  } else {
    whois = { whois: async () => null };
    writeDiagnostic("warn", "admin.local_dev_mode", { environment: config.environment });
  }

  const health = startHealthListener(config.healthPort, state, supervisor);
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    health.close();
    await supervisor?.stop();
    process.exit(code);
  };

  if (supervisor) {
    supervisor.onExit(() => {
      writeDiagnostic("error", "admin.tailscale_daemon_exited", {});
      void shutdown(1);
    });
    identity = await supervisor.start();
    state.tailscale = true;
    if (config.tailscale.authKey) {
      console.warn("[admin] TS_AUTHKEY is still set; delete the variable now that the node is registered.");
    }
  } else {
    state.tailscale = true;
  }

  const pools: AdminPools = createAdminPools({
    readerDatabaseUrl: config.readerDatabaseUrl,
    operatorDatabaseUrl: config.operatorDatabaseUrl,
    mode: config.mode,
  });
  const readerIdentity = await verifyDatabaseIdentity(pools.reader, {
    role: config.readerRole,
    environment: config.environment,
  });
  if (pools.operator) {
    await verifyDatabaseIdentity(pools.operator, {
      role: config.operatorRole,
      environment: config.environment,
    });
  }
  state.database = true;

  const audit = new AdminAuditWriter();
  const bootCorrelation = randomUUID();
  await audit.appendEvent(pools.reader, {
    actor: { id: "system@letter-irl-admin", name: "admin service" },
    environment: config.environment,
    mode: config.mode,
    sessionIdHash: hashSessionId(`boot:${bootCorrelation}`),
    correlationId: bootCorrelation,
    action: "admin.boot",
    targetType: "service",
    targetId: config.tailscale.hostname,
    inputSummary: {
      mode: config.mode,
      tailscaleMode: config.tailscale.mode,
      node: identity?.dnsName ?? "local-dev",
      tag: config.tailscale.tag,
      build: config.buildCommit,
      stripeKeyMode: config.stripeKeyMode,
      letterProvider: config.letterProvider,
      databaseRole: readerIdentity.roleName,
      marker: readerIdentity.marker,
    },
    outcome: "succeeded",
  });

  const clientScript = await loadClientScript();
  const sessions = new AdminSessionStore({
    idleTtlMs: config.session.idleTtlMs,
    absoluteTtlMs: config.session.absoluteTtlMs,
  });
  const router = registerReadRoutes(new AdminRouter<RouteHandler>(), clientScript);
  const listener = createAdminRequestListener({
    config,
    pools,
    sessions,
    whois,
    audit,
    router,
    nodeName: identity?.dnsName ?? null,
    banner: {
      environment: config.environment,
      mode: config.mode,
      marker: readerIdentity.marker,
      databaseRole: readerIdentity.roleName,
      stripeKeyMode: config.stripeKeyMode,
      stripeKeyRestricted: config.stripeKeyRestricted,
      letterProvider: config.letterProvider,
      buildCommit: config.buildCommit,
      tag: config.tailscale.tag,
    },
    nav: NAV_ITEMS,
    clientScript,
  });
  const app = http.createServer(listener);
  app.requestTimeout = 30_000;
  app.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    app.once("error", reject);
    app.listen(config.appPort, "127.0.0.1", () => resolve());
  });
  state.listening = true;
  writeDiagnostic("info", "admin.listening", {
    appPort: config.appPort,
    mode: config.mode,
    environment: config.environment,
  });

  const drain = async (signal: string) => {
    writeDiagnostic("info", "admin.shutdown", { signal });
    closing = true;
    app.close();
    health.close();
    sessions.destroyAll();
    await closeAdminPools(pools);
    await supervisor?.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void drain("SIGTERM"));
  process.on("SIGINT", () => void drain("SIGINT"));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly || process.env.ADMIN_SERVER_MAIN === "true") {
  main().catch((error) => {
    const code = error instanceof AdminFoundationError ? error.code : "ADMIN_INTERNAL_ERROR";
    writeDiagnostic("error", "admin.boot_failed", {
      code,
      errorClass: classifyDiagnosticError(error, "unknown_error"),
    });
    console.error(`[admin] boot failed: ${code}`);
    process.exit(1);
  });
}
