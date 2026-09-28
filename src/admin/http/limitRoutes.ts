import { renderLimits } from "../pages/limits.js";
import {
  listUnclearedOverrides,
  readLimitDefaults,
  readTodayRefusals,
  readTodayUse,
} from "../queries/limits.js";
import type { RouteHandler } from "./app.js";
import type { AdminRouter } from "./router.js";

/** The daily limits page (migration 038). Reads only; changes go through limit.set and limit.clear. */
export function registerLimitRoutes(router: AdminRouter<RouteHandler>): void {
  router.add("GET", "/limits", async (context) => {
    const data = await context.read(async (client) => ({
      defaults: await readLimitDefaults(client),
      overrides: await listUnclearedOverrides(client),
      refusals: await readTodayRefusals(client),
      use: await readTodayUse(client),
    }));
    return context.render("Limits", renderLimits({ ...data, mode: context.config.mode }));
  }, { name: "limits" });
}
