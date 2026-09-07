import { AdminFoundationError } from "../errors.js";
import { prepareCommandPreview, runAdminCommand, type CommandDefinition } from "../commands/runner.js";
import {
  alertActionPanel,
  jobActionPanel,
  renderCommandOutcome,
  renderCommandPreview,
  renderElevationForm,
} from "../pages/commands.js";
import type { RequestContext, RouteHandler } from "./app.js";
import { attemptElevation, dropElevation, isElevated } from "./elevation.js";
import type { AdminRouter } from "./router.js";
import type { RouteExtensions } from "./routes.js";
import { hashSessionId } from "./session.js";

/**
 * Elevation and command routes (slice 2). Previews are GET and work in any
 * mode; execution is POST, marked as a write so read-only mode refuses it
 * before the handler, and the runner re-checks mode and elevation itself.
 */

const RETURN_PATH = /^\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/;

function safeReturn(value: string | null | undefined): string {
  if (!value || value.length > 500 || !value.startsWith("/") || value.startsWith("//") || !RETURN_PATH.test(value)) {
    return "/";
  }
  return value;
}

function backHrefFor(command: CommandDefinition<any>, targetId: string): string {
  switch (command.targetType) {
    case "commerce_alert":
      return `/alerts/${encodeURIComponent(targetId)}`;
    case "letter_job":
      return `/jobs/${encodeURIComponent(targetId)}`;
    case "order":
      return `/orders/${encodeURIComponent(targetId)}`;
    case "user":
      return `/accounts/${encodeURIComponent(targetId)}`;
    case "promo_campaign":
      return /^[0-9a-f-]{36}$/i.test(targetId) ? `/promos/${encodeURIComponent(targetId)}` : "/promos";
    case "image_reservation":
      return "/images";
    case "provider_routing":
    case "provider":
      return "/routing";
    default:
      return "/";
  }
}

function targetIdFrom(context: RequestContext): string {
  const target = (context.form?.get("target") ?? context.url.searchParams.get("target") ?? "").trim();
  if (!target || target.length > 255) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
  return target;
}

/** Every non-control field the command may read, from the query (preview) or the body (execute). */
function fieldsFrom(context: RequestContext): Map<string, string> {
  const fields = new Map<string, string>();
  const source: Iterable<[string, string]> = context.form ?? context.url.searchParams;
  for (const [name, value] of source) {
    if (!fields.has(name)) fields.set(name, value);
  }
  return fields;
}

const CONTROL_FIELDS = new Set(["_csrf", "target", "previewDigest", "expectedVersion", "idempotencyKey", "reason", "phrase"]);

export function registerCommandRoutes(
  router: AdminRouter<RouteHandler>,
  commands: ReadonlyArray<CommandDefinition<any>>,
): RouteExtensions {
  const byName = new Map(commands.map((command) => [command.name, command]));

  router.add("GET", "/elevate", async (context) => {
    const now = Date.now();
    return context.render(
      "Elevate",
      renderElevationForm({
        csrfToken: context.csrfToken,
        returnTo: safeReturn(context.url.searchParams.get("return")),
        elevatedUntil: isElevated(context.session, now) ? new Date(context.session.elevatedUntil as number) : null,
        lockedUntil:
          context.session.elevationLockedUntil && context.session.elevationLockedUntil > now
            ? new Date(context.session.elevationLockedUntil)
            : null,
        message: null,
        ttlMinutes: Math.round(context.config.session.elevationTtlMs / 60_000),
        mode: context.config.mode,
      }),
    );
  }, { name: "elevate.form" });

  router.add("POST", "/elevate", async (context) => {
    const now = Date.now();
    const returnTo = safeReturn(context.form?.get("return"));
    if (!context.config.totpSecret) throw new AdminFoundationError("ADMIN_COMMAND_DISABLED");
    const attempt = attemptElevation(
      context.session,
      context.config.totpSecret,
      context.form?.get("code") ?? "",
      {
        ttlMs: context.config.session.elevationTtlMs,
        maxFailures: context.config.session.elevationMaxFailures,
        failureWindowMs: context.config.session.elevationFailureWindowMs,
      },
      now,
    );
    if (attempt.ok) {
      // Renew the session id after the privilege change; the store keeps the
      // elevation on the rotated session.
      const rotated = context.sessions.rotate(context.session);
      context.setSessionCookie(rotated);
      await context.audit.appendEvent(context.pools.reader, {
        actor: context.actor,
        environment: context.config.environment,
        mode: context.config.mode,
        sessionIdHash: hashSessionId(rotated.id),
        correlationId: context.correlationId,
        action: "admin.elevate",
        targetType: "session",
        inputSummary: { elevatedUntil: new Date(attempt.elevatedUntil).toISOString() },
        outcome: "succeeded",
      });
      return context.redirect(returnTo, { tone: "ok", text: "Elevated. Commands are enabled for this session until the elevation expires." });
    }
    await context.appendAudit({
      action: "admin.elevation_denied",
      targetType: "session",
      inputSummary: { reason: attempt.reason, failuresLeft: attempt.failuresLeft },
      outcome: "denied",
      errorCode: attempt.reason === "locked" ? "ADMIN_ELEVATION_LOCKED" : "ADMIN_FORBIDDEN",
    });
    return context.render(
      "Elevate",
      renderElevationForm({
        csrfToken: context.csrfToken,
        returnTo,
        elevatedUntil: null,
        lockedUntil: attempt.lockedUntil ? new Date(attempt.lockedUntil) : null,
        message:
          attempt.reason === "locked"
            ? "Too many failed codes; elevation is locked for this session."
            : attempt.reason === "replayed"
              ? "That code was already used; wait for the next one."
              : `The code was not accepted (${attempt.failuresLeft} attempts left before lockout).`,
        ttlMinutes: Math.round(context.config.session.elevationTtlMs / 60_000),
        mode: context.config.mode,
      }),
      { status: 403 },
    );
  }, { name: "elevate", write: true });

  router.add("POST", "/elevate/drop", async (context) => {
    dropElevation(context.session);
    await context.appendAudit({ action: "admin.elevation_dropped", targetType: "session", outcome: "succeeded" });
    return context.redirect(safeReturn(context.form?.get("return")), { tone: "ok", text: "Elevation dropped." });
  }, { name: "elevate.drop", write: true });

  router.add("GET", "/commands/:name/preview", async (context) => {
    const command = byName.get(context.params.name);
    if (!command) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    const targetId = targetIdFrom(context);
    const fields = fieldsFrom(context);
    const prepared = await context.read((client) =>
      prepareCommandPreview(command, client, context.config.environment, targetId, fields),
    );
    const hiddenFields = [...fields].filter(([name]) => !CONTROL_FIELDS.has(name));
    return context.render(
      command.title,
      renderCommandPreview({
        title: command.title,
        commandName: command.name,
        targetId: prepared.preview.targetId,
        preview: prepared.preview,
        previewDigest: prepared.previewDigest,
        idempotencyKey: prepared.idempotencyKey,
        phrase: prepared.phrase,
        hiddenFields,
        csrfToken: context.csrfToken,
        mode: context.config.mode,
        elevated: isElevated(context.session, Date.now()),
        environment: context.config.environment,
        backHref: backHrefFor(command, prepared.preview.targetId),
      }),
    );
  }, { name: "command.preview" });

  router.add("POST", "/commands/:name", async (context) => {
    const command = byName.get(context.params.name);
    if (!command) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    const targetId = targetIdFrom(context);
    const fields = fieldsFrom(context);
    const outcome = await runAdminCommand(
      {
        config: context.config,
        reader: context.pools.reader,
        operator: context.pools.operator,
        audit: context.audit,
        actor: context.actor,
        session: context.session,
        sessionIdHash: hashSessionId(context.session.id),
        correlationId: context.correlationId,
        now: () => Date.now(),
      },
      command,
      targetId,
      fields,
    );
    return context.render(
      command.title,
      renderCommandOutcome({ title: command.title, outcome, backHref: backHrefFor(command, targetId) }),
    );
  }, { name: "command.execute", write: true });

  return {
    alertActions: (context, alertId, status) => alertActionPanel({ alertId, status, mode: context.config.mode }),
    jobActions: (context, jobId, status, providerOutcome) =>
      jobActionPanel({ jobId, status, providerOutcome, mode: context.config.mode }),
  };
}
