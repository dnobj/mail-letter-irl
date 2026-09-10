import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type pg from "pg";

import type { AdminAuditWriter } from "../auditService.js";
import type { AdminAuditEventInput } from "../contracts.js";
import type { AdminSqlClient } from "../database.js";
import { withReadOnlyTransaction, type AdminPools } from "../db.js";
import { AdminFoundationError, type AdminErrorCode } from "../errors.js";
import type { AdminRuntimeConfig } from "../runtimeConfig.js";
import type { WhoisClient } from "../tailscale/cli.js";
import { renderError } from "../pages/error.js";
import { html, type SafeHtml } from "../ui/html.js";
import { renderPage, type BannerModel, type FlashMessage, type NavItem } from "../ui/layout.js";
import { readRequestBody, RequestBodyTooLargeError } from "../../utils/requestBody.js";
import { classifyDiagnosticError, writeDiagnostic } from "../../utils/diagnosticLog.js";
import type { ElevationGuard } from "./elevation.js";
import type { AdminRouter } from "./router.js";
import {
  FORM_BODY_LIMIT_BYTES,
  SlidingWindowLimiter,
  buildSecurityHeaders,
  checkStateChangingRequest,
  createCsrfToken,
  createNonce,
  parseFormBody,
  verifyCsrfToken,
} from "./security.js";
import {
  AdminSessionStore,
  SESSION_COOKIE_NAME,
  clearedSessionCookie,
  hashSessionId,
  parseCookies,
  sessionCookie,
  type AdminSession,
} from "./session.js";
import { authenticateAdminRequest, type AuthenticatedActor } from "./tailscaleAuth.js";
import { DenialAuditBudget, denialBurstEvent } from "./denialAuditBudget.js";

/**
 * The request pipeline: correlation id, authentication, session, browser-
 * boundary checks for POSTs, routing, rendering, headers, audit of every
 * denial and failure. Handlers see a small typed context and return a page,
 * a redirect or a plain body; they never touch the raw response.
 */

export type PageResponse =
  | { kind: "html"; status: number; body: string }
  | { kind: "redirect"; location: string }
  | { kind: "raw"; status: number; body: string; contentType: string };

export interface RequestContext {
  correlationId: string;
  nonce: string;
  url: URL;
  method: string;
  params: Record<string, string>;
  actor: AuthenticatedActor;
  session: AdminSession;
  csrfToken: string;
  form: Map<string, string> | null;
  config: AdminRuntimeConfig;
  pools: AdminPools;
  audit: AdminAuditWriter;
  sessions: AdminSessionStore;
  /** Elevation state that outlives a session: failures, lock, TOTP counter. */
  elevation: ElevationGuard;
  /** Run a read model inside a READ ONLY transaction on the reader pool. */
  read<T>(callback: (client: AdminSqlClient) => Promise<T>): Promise<T>;
  /** The operator pool, or a refusal in read-only mode. */
  requireOperatorPool(): pg.Pool;
  render(title: string, body: SafeHtml, options?: { status?: number }): PageResponse;
  redirect(location: string, flash?: FlashMessage): PageResponse;
  appendAudit(
    event: Omit<
      AdminAuditEventInput,
      "actor" | "environment" | "mode" | "sessionIdHash" | "correlationId"
    >,
  ): Promise<void>;
  /** Present when the session was rotated during this request. */
  setSessionCookie(session: AdminSession): void;
  clearSessionCookie(): void;
}

export type RouteHandler = (context: RequestContext) => Promise<PageResponse>;

export interface AdminAppOptions {
  config: AdminRuntimeConfig;
  pools: AdminPools;
  sessions: AdminSessionStore;
  elevation: ElevationGuard;
  whois: WhoisClient;
  audit: AdminAuditWriter;
  router: AdminRouter<RouteHandler>;
  /** The node's MagicDNS name (no trailing dot); null in local-dev mode. */
  nodeName: string | null;
  banner: Omit<BannerModel, "nodeName">;
  nav: NavItem[];
  clientScript: { path: string; body: string };
  now?: () => number;
  /** Shared with the server so the pending burst row is flushed at shutdown. */
  denialBudget?: DenialAuditBudget;
}

const ANONYMOUS_ACTOR = { id: "anonymous@unauthenticated", name: "anonymous" };
const CONSTANT_BODIES: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not found",
  405: "method not allowed",
  429: "too many requests",
};

export function createAdminRequestListener(
  options: AdminAppOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const now = options.now ?? (() => Date.now());
  const requestLimiter = new SlidingWindowLimiter(240, 60_000, now);
  // A human types one six-digit code at a time, so the elevation route gets a
  // limit of its own well below the general one. Keyed on the login, like the
  // lock it protects, so dropping the session cookie does not reset it.
  const elevationLimiter = new SlidingWindowLimiter(10, 60_000, now);
  const denialLimiter = new SlidingWindowLimiter(30, 60_000, now);
  // Sixty individual denial rows a minute for the process; beyond that the
  // denials are counted and written as one admin.request_denied_burst row per
  // window instead of being dropped (audit A-15).
  const denialBudget = options.denialBudget ?? new DenialAuditBudget({ limit: 60, windowMs: 60_000, now });
  denialBudget.setSink((summary) => safeAudit(options, denialBurstEvent(summary)));
  const allowedLogins = new Set(options.config.operatorLogins);
  const expectedOrigins = options.nodeName
    ? [`https://${options.nodeName}`]
    : [
        `http://localhost:${options.config.appPort}`,
        `http://127.0.0.1:${options.config.appPort}`,
      ];
  const localDev =
    options.config.tailscale.mode === "local-dev" && options.config.tailscale.localDevLogin
      ? { login: options.config.tailscale.localDevLogin, name: "local developer" }
      : null;

  return (request, response) => {
    void handle(request, response).catch((error) => {
      // Last resort: the handler itself failed while writing the response.
      writeDiagnostic("error", "admin.request_unhandled", {
        errorClass: classifyDiagnosticError(error, "unknown_error"),
      });
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
      }
      response.end("error");
    });
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = now();
    const correlationId = randomUUID();
    const nonce = createNonce();
    const method = (request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", "http://admin.local");
    const cookies = parseCookies(request.headers.cookie);
    const headers = buildSecurityHeaders(nonce);
    headers["X-Correlation-Id"] = correlationId;
    const cookiesToSet: string[] = [];

    const finish = (status: number, body: string, contentType: string) => {
      response.statusCode = status;
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      if (cookiesToSet.length > 0) response.setHeader("Set-Cookie", cookiesToSet);
      response.setHeader("Content-Type", contentType);
      response.setHeader("Content-Length", Buffer.byteLength(body));
      response.end(method === "HEAD" ? undefined : body);
      writeDiagnostic("info", "admin.request", {
        correlationId,
        method,
        status,
        ms: now() - startedAt,
      });
    };
    const constant = (status: number) =>
      finish(status, CONSTANT_BODIES[status] ?? "error", "text/plain; charset=utf-8");

    const peer = request.socket.remoteAddress;
    const auth = await authenticateAdminRequest(
      {
        remoteAddress: peer,
        header: (name) => {
          const value = request.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
        cookie: (name) => cookies.get(name),
      },
      {
        allowedLogins,
        expectedHost: options.nodeName,
        whois: options.whois,
        sessions: options.sessions,
        localDev,
      },
    );

    if (!auth.ok) {
      const key = `${peer ?? "?"}:${auth.presentedLogin ?? "-"}`;
      const deniedActor = auth.presentedLogin ?? ANONYMOUS_ACTOR.id;
      // Two caps on individual rows, one per peer and login and one for the
      // process. Neither silences a denial: what is not written on its own is
      // counted into the window's burst row.
      const individually = denialLimiter.allow(key)
        ? await denialBudget.admit(deniedActor, auth.code)
        : (await denialBudget.suppress(deniedActor, auth.code), false);
      if (individually) {
        await safeAudit(options, {
          actor: auth.presentedLogin
            ? { id: auth.presentedLogin, name: "denied" }
            : ANONYMOUS_ACTOR,
          sessionIdHash: hashSessionId(`denied:${correlationId}`),
          correlationId,
          action: "admin.request_denied",
          targetType: "route",
          targetId: url.pathname.slice(0, 255),
          inputSummary: { reason: auth.reason },
          outcome: "denied",
          errorCode: auth.code,
        });
      }
      if (cookies.has(SESSION_COOKIE_NAME)) cookiesToSet.push(clearedSessionCookie());
      constant(auth.code === "ADMIN_FORBIDDEN" ? 403 : 401);
      return;
    }

    const { actor } = auth;
    let session = auth.session;
    if (auth.created) {
      cookiesToSet.push(sessionCookie(session.id));
      await safeAudit(options, {
        actor,
        sessionIdHash: hashSessionId(session.id),
        correlationId,
        action: "admin.session_start",
        targetType: "session",
        inputSummary: { replaced: auth.replaced ?? "none", peer: session.peerAddress },
        outcome: "succeeded",
      });
    }
    if (!requestLimiter.allow(actor.id)) {
      // A denial like any other, under the same budget, so a flood cannot
      // make the audit table the amplifier.
      if (await denialBudget.admit(actor.id, "ADMIN_RATE_LIMITED")) {
        await safeAudit(options, {
          actor,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
          action: "admin.request_denied",
          targetType: "route",
          targetId: url.pathname.slice(0, 255),
          inputSummary: { reason: "rate_limited" },
          outcome: "denied",
          errorCode: "ADMIN_RATE_LIMITED",
        });
      }
      constant(429);
      return;
    }

    const csrfToken = createCsrfToken(options.config.sessionSecret, session.id);
    const matched = options.router.match(method === "HEAD" ? "GET" : method, url.pathname);
    if (matched.kind === "not_found") {
      finish(
        404,
        renderShell("Not found", renderError({
          status: 404,
          code: "ADMIN_NOT_FOUND",
          message: "There is no such page.",
          correlationId,
        }), null),
        "text/html; charset=utf-8",
      );
      return;
    }
    if (matched.kind === "method_not_allowed") {
      constant(405);
      return;
    }

    let form: Map<string, string> | null = null;
    if (method === "POST") {
      const boundary = checkStateChangingRequest(
        { method, header: (name) => headerValue(request, name) },
        expectedOrigins,
      );
      if (boundary) {
        await safeAudit(options, {
          actor,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
          action: "admin.request_denied",
          targetType: "route",
          targetId: matched.route.name,
          inputSummary: { reason: "browser_boundary", detail: boundary.detail },
          outcome: "denied",
          errorCode: boundary.code,
        });
        constant(boundary.code === "ADMIN_METHOD_NOT_ALLOWED" ? 405 : 403);
        return;
      }
      let body: string;
      try {
        body = await readRequestBody(request, { limitBytes: FORM_BODY_LIMIT_BYTES });
      } catch (error) {
        constant(error instanceof RequestBodyTooLargeError ? 413 : 400);
        return;
      }
      form = parseFormBody(body);
      if (!verifyCsrfToken(options.config.sessionSecret, session.id, form.get("_csrf"))) {
        await safeAudit(options, {
          actor,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
          action: "admin.request_denied",
          targetType: "route",
          targetId: matched.route.name,
          inputSummary: { reason: "csrf_token" },
          outcome: "denied",
          errorCode: "ADMIN_CSRF_REJECTED",
        });
        constant(403);
        return;
      }
      if (
        (matched.route.name === "elevate" || matched.route.name === "elevate.drop") &&
        !elevationLimiter.allow(actor.id)
      ) {
        await safeAudit(options, {
          actor,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
          action: "admin.request_denied",
          targetType: "route",
          targetId: matched.route.name,
          inputSummary: { reason: "elevation_rate_limited" },
          outcome: "denied",
          errorCode: "ADMIN_RATE_LIMITED",
        });
        constant(429);
        return;
      }
      if (matched.route.write && options.config.mode !== "full") {
        await safeAudit(options, {
          actor,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
          action: "admin.request_denied",
          targetType: "route",
          targetId: matched.route.name,
          inputSummary: { reason: "read_only_mode" },
          outcome: "denied",
          errorCode: "ADMIN_READ_ONLY_MODE",
        });
        finish(
          403,
          renderShell(
            "Read-only",
            renderError({
              status: 403,
              code: "ADMIN_READ_ONLY_MODE",
              message: "This admin service runs in read-only mode; commands are refused before anything executes.",
              correlationId,
            }),
            session,
          ),
          "text/html; charset=utf-8",
        );
        return;
      }
    }

    const flash = session.flash;
    session.flash = null;

    const context: RequestContext = {
      correlationId,
      nonce,
      url,
      method,
      params: matched.params,
      actor,
      session,
      csrfToken,
      form,
      config: options.config,
      pools: options.pools,
      audit: options.audit,
      sessions: options.sessions,
      elevation: options.elevation,
      read: (callback) => withReadOnlyTransaction(options.pools.reader, callback),
      requireOperatorPool: () => {
        if (!options.pools.operator) throw new AdminFoundationError("ADMIN_READ_ONLY_MODE");
        return options.pools.operator;
      },
      render: (title, body, renderOptions) => ({
        kind: "html",
        status: renderOptions?.status ?? 200,
        body: renderShell(title, body, session, flash),
      }),
      redirect: (location, nextFlash) => {
        if (nextFlash) session.flash = nextFlash;
        return { kind: "redirect", location };
      },
      appendAudit: async (event) => {
        await options.audit.appendEvent(options.pools.reader, {
          ...event,
          actor,
          environment: options.config.environment,
          mode: options.config.mode,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
        });
      },
      setSessionCookie: (rotated) => {
        session = rotated;
        cookiesToSet.push(sessionCookie(rotated.id));
      },
      clearSessionCookie: () => {
        cookiesToSet.push(clearedSessionCookie());
      },
    };

    try {
      const result = await matched.route.handler(context);
      if (result.kind === "redirect") {
        headers["Location"] = result.location;
        finish(303, "", "text/plain; charset=utf-8");
      } else if (result.kind === "raw") {
        finish(result.status, result.body, result.contentType);
      } else {
        finish(result.status, result.body, "text/html; charset=utf-8");
      }
    } catch (error) {
      const known = error instanceof AdminFoundationError ? error : null;
      const status = known?.httpStatus ?? 500;
      const code: AdminErrorCode = known?.code ?? "ADMIN_INTERNAL_ERROR";
      writeDiagnostic("error", "admin.request_failed", {
        correlationId,
        route: matched.route.name,
        code,
        errorClass: classifyDiagnosticError(error, "unknown_error"),
      });
      // Every failure of a write route is audited whatever its status: a 400
      // during a command preview or execution is an attempt an operator made,
      // and a fumbling or probing operator should leave a trace (A-15).
      if (matched.route.write || status >= 500 || status === 403 || status === 409) {
        await safeAudit(options, {
          actor,
          sessionIdHash: hashSessionId(session.id),
          correlationId,
          action: "admin.request_failed",
          targetType: "route",
          targetId: matched.route.name,
          outcome: status === 403 ? "denied" : "failed",
          errorCode: code,
        });
      }
      finish(
        status,
        renderShell(
          "Error",
          renderError({
            status,
            code,
            message: known?.message ?? "The admin operation failed.",
            correlationId,
          }),
          session,
        ),
        "text/html; charset=utf-8",
      );
    }

    function renderShell(
      title: string,
      body: SafeHtml,
      current: AdminSession | null,
      flashMessage: FlashMessage | null = null,
    ): string {
      return renderPage({
        title,
        nonce,
        banner: { ...options.banner, nodeName: options.nodeName },
        nav: options.nav,
        currentPath: url.pathname,
        actor: current ? actor : null,
        csrfToken: current ? csrfToken : null,
        scriptPath: options.clientScript.path,
        flash: flashMessage,
        elevatedUntil:
          current?.elevatedUntil && current.elevatedUntil > now()
            ? new Date(current.elevatedUntil)
            : null,
        body,
      });
    }
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function safeAudit(
  options: AdminAppOptions,
  event: Omit<AdminAuditEventInput, "environment" | "mode">,
): Promise<void> {
  try {
    await options.audit.appendEvent(options.pools.reader, {
      ...event,
      environment: options.config.environment,
      mode: options.config.mode,
    });
  } catch (error) {
    writeDiagnostic("error", "admin.audit_write_failed", {
      errorClass: classifyDiagnosticError(error, "database_error"),
    });
  }
}

/** The path the compiled client script is served at: content-addressed. */
export function clientScriptPath(body: string): string {
  return `/assets/client-${createHash("sha256").update(body).digest("hex").slice(0, 16)}.js`;
}

export function textResponse(body: string, contentType = "text/plain; charset=utf-8"): PageResponse {
  return { kind: "raw", status: 200, body, contentType };
}

export function notFound(): never {
  throw new AdminFoundationError("ADMIN_NOT_FOUND");
}

export const EMPTY_ACTIONS: SafeHtml = html``;
