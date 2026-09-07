import { reconcileStripePayments } from "../../services/stripeReconciliationService.js";
import { carriedDiagnosticClass, classifyDiagnosticError, writeDiagnostic } from "../../utils/diagnosticLog.js";
import { AdminFoundationError } from "../errors.js";
import { orderActionPanel, renderStripe, type ReconciliationResult } from "../pages/stripe.js";
import { listAuditEvents } from "../queries/audit.js";
import { boundedLimit } from "../queries/paging.js";
import type { RouteHandler } from "./app.js";
import type { AdminRouter } from "./router.js";
import type { RouteExtensions } from "./routes.js";

/**
 * Stripe-side reads (slice 3). Reconciliation reads Stripe with the
 * service's restricted key and writes nothing but an audit row that carries
 * the counts and order ids, never Stripe identifiers, so it is allowed in
 * read-only mode. The repair and refund commands themselves are registered
 * with the other commands.
 */

export interface StripeRouteSeams {
  reconcile: (days: number) => Promise<ReconciliationResult>;
}

const DEFAULT_DAYS = 30;

export function registerStripeRoutes(
  router: AdminRouter<RouteHandler>,
  seams: StripeRouteSeams = { reconcile: (days) => reconcileStripePayments(days) },
): Pick<RouteExtensions, "orderActions"> {
  router.add("GET", "/stripe", async (context) => {
    const recentRuns = await context.read((client) =>
      listAuditEvents(client, { limit: 10, action: "stripe.reconcile" }),
    );
    return context.render(
      "Stripe",
      renderStripe({
        days: DEFAULT_DAYS,
        result: null,
        recentRuns: recentRuns.rows,
        csrfToken: context.csrfToken,
        mode: context.config.mode,
        stripeKeyMode: context.config.stripeKeyMode,
        stripeKeyRestricted: context.config.stripeKeyRestricted,
      }),
    );
  }, { name: "stripe" });

  router.add("POST", "/stripe/reconcile", async (context) => {
    const days = boundedLimit(context.form?.get("days"), DEFAULT_DAYS, 90);
    if (context.config.stripeKeyMode === "absent") {
      throw new AdminFoundationError("ADMIN_COMMAND_DISABLED");
    }
    let result: ReconciliationResult;
    try {
      result = await seams.reconcile(days);
    } catch (error) {
      const errorClass = carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, "provider_error");
      writeDiagnostic("error", "admin.stripe_reconcile_failed", { correlationId: context.correlationId, errorClass });
      await context.appendAudit({
        action: "stripe.reconcile",
        targetType: "stripe",
        targetId: `last-${days}-days`,
        inputSummary: { days },
        outcome: "failed",
        errorCode: errorClass === "configuration_error" ? "ADMIN_COMMAND_DISABLED" : "ADMIN_PROVIDER_ERROR",
      });
      throw new AdminFoundationError(
        errorClass === "configuration_error" ? "ADMIN_COMMAND_DISABLED" : "ADMIN_PROVIDER_ERROR",
      );
    }
    const byType: Record<string, number> = {};
    for (const discrepancy of result.discrepancies) {
      byType[discrepancy.type] = (byType[discrepancy.type] ?? 0) + 1;
    }
    await context.appendAudit({
      action: "stripe.reconcile",
      targetType: "stripe",
      targetId: `last-${days}-days`,
      inputSummary: { days },
      afterSummary: {
        stripePayments: result.summary.stripePayments,
        ourCredits: result.summary.ourCredits,
        matched: result.summary.matched,
        missingInOurSystem: result.summary.missingInOurSystem,
        missingInStripe: result.summary.missingInStripe,
        amountMismatches: result.summary.amountMismatches,
        unprocessedRefunds: result.summary.unprocessedRefunds,
        discrepancyTypes: byType,
        // Order ids only: Stripe identifiers stay on the page.
        orderIds: result.discrepancies
          .map((discrepancy) => discrepancy.orderId ?? null)
          .filter((orderId): orderId is string => orderId !== null)
          .slice(0, 50),
      },
      outcome: "succeeded",
    });
    const recentRuns = await context.read((client) =>
      listAuditEvents(client, { limit: 10, action: "stripe.reconcile" }),
    );
    return context.render(
      "Stripe",
      renderStripe({
        days,
        result,
        recentRuns: recentRuns.rows,
        csrfToken: context.csrfToken,
        mode: context.config.mode,
        stripeKeyMode: context.config.stripeKeyMode,
        stripeKeyRestricted: context.config.stripeKeyRestricted,
      }),
    );
  }, { name: "stripe.reconcile", write: false });

  return {
    orderActions: (context, orderId, refundable) =>
      orderActionPanel({
        orderId,
        refundable,
        commandEnabled: context.config.packRefundCommandEnabled,
        mode: context.config.mode,
      }),
  };
}
