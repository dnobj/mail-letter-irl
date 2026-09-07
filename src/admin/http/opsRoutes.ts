import { listProviders } from "../../services/providers/index.js";
import { runRetentionPreview, type RetentionPreviewResult } from "../../services/retentionService.js";
import { carriedDiagnosticClass, classifyDiagnosticError } from "../../utils/diagnosticLog.js";
import { renderRetention, renderRouting, renderSupport } from "../pages/ops.js";
import { listFeatureRequests, listQuarantine, listRouting, listStuckLetters, readRetentionCounts, readTokenStats } from "../queries/ops.js";
import type { RouteHandler } from "./app.js";
import type { AdminRouter } from "./router.js";

/** Retention, routing and support pages (slice 5). Reads only. */
export interface OpsRouteSeams {
  retentionReport: () => Promise<RetentionPreviewResult>;
  providers: () => string[];
}

export function registerOpsRoutes(
  router: AdminRouter<RouteHandler>,
  seams: OpsRouteSeams = { retentionReport: () => runRetentionPreview(), providers: () => listProviders() },
): void {
  router.add("GET", "/retention", async (context) => {
    const data = await context.read(async (client) => ({
      counts: await readRetentionCounts(client),
      quarantine: await listQuarantine(client, 100),
    }));
    let report: RetentionPreviewResult | null = null;
    let reportError: string | null = null;
    try {
      report = await seams.retentionReport();
    } catch (error) {
      reportError = carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, "database_error");
    }
    return context.render("Retention", renderRetention({ ...data, report, reportError }));
  }, { name: "retention" });

  router.add("GET", "/routing", async (context) => {
    const data = await context.read(async (client) => ({
      rows: await listRouting(client),
      stuck: await listStuckLetters(client, 14, 50),
    }));
    return context.render(
      "Routing",
      renderRouting({
        ...data,
        providers: seams.providers(),
        defaultProvider: context.config.letterProvider,
        mode: context.config.mode,
        environment: context.config.environment,
      }),
    );
  }, { name: "routing" });

  router.add("GET", "/support", async (context) => {
    const data = await context.read(async (client) => ({
      tokenStats: await readTokenStats(client),
      featureRequests: await listFeatureRequests(client, 100),
    }));
    return context.render("Support", renderSupport(data));
  }, { name: "support" });
}
