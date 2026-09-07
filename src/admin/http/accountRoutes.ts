import { AdminFoundationError } from "../errors.js";
import { accountActionPanel, orderQuarantinePanel } from "../pages/accountActions.js";
import { renderImages } from "../pages/images.js";
import { renderPromoDetail, renderPromoForm, renderPromos } from "../pages/promos.js";
import { listAmbiguousReservations, listEntitlements } from "../queries/images.js";
import { listCampaignRedemptions, listCampaigns, readCampaign } from "../queries/promos.js";
import type { RouteHandler } from "./app.js";
import type { AdminRouter } from "./router.js";
import type { RouteExtensions } from "./routes.js";

/**
 * Promo, image-recovery and account-action routes (slice 4). Reads only; the
 * writes they lead to are commands.
 */
export function registerAccountRoutes(router: AdminRouter<RouteHandler>): Pick<RouteExtensions, "accountActions" | "orderActions"> {
  router.add("GET", "/promos", async (context) => {
    const campaigns = await context.read((client) => listCampaigns(client, 100));
    return context.render("Promos", renderPromos({ campaigns, mode: context.config.mode }));
  }, { name: "promos" });

  router.add("GET", "/promos/new", async (context) => context.render("Create promo", renderPromoForm()), { name: "promos.new" });

  router.add("GET", "/promos/:campaignId", async (context) => {
    const data = await context.read(async (client) => {
      const campaign = await readCampaign(client, context.params.campaignId);
      if (!campaign) return null;
      return { campaign, redemptions: await listCampaignRedemptions(client, campaign.campaignId, 100) };
    });
    if (!data) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    return context.render(`Promo ${data.campaign.code}`, renderPromoDetail({ ...data, mode: context.config.mode }));
  }, { name: "promo" });

  router.add("GET", "/images", async (context) => {
    const reservations = await context.read((client) => listAmbiguousReservations(client, 100));
    return context.render("Images", renderImages({ reservations, mode: context.config.mode }));
  }, { name: "images" });

  return {
    accountActions: async (context, detail) => {
      const entitlements = await context.read((client) => listEntitlements(client, detail.account.userId));
      return accountActionPanel({ detail, entitlements, mode: context.config.mode });
    },
    orderActions: async (context, detail) => orderQuarantinePanel({ detail, mode: context.config.mode }),
  };
}
