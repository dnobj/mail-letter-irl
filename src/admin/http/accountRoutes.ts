import { AdminFoundationError } from "../errors.js";
import { giftOperatorGenerationsRemaining } from "../../config/giftLetters.js";
import { readAccountErased, readErasureFollowup, readLatestErasure } from "../../services/accountErasureService.js";
import { accountActionPanel, accountErasurePanel, orderQuarantinePanel } from "../pages/accountActions.js";
import { accountGiftPanel, renderGifts } from "../pages/gifts.js";
import { renderImages } from "../pages/images.js";
import { renderPromoDetail, renderPromoForm, renderPromos } from "../pages/promos.js";
import { listGiftCodes, listGiftLetters, readGiftTotals } from "../queries/gifts.js";
import { listAmbiguousReservations, listEntitlements } from "../queries/images.js";
import { join } from "../ui/html.js";
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

  router.add("GET", "/gifts", async (context) => {
    const data = await context.read(async (client) => ({
      totals: await readGiftTotals(client),
      codes: await listGiftCodes(client, { limit: 100 }),
    }));
    return context.render("Gifts", renderGifts({ ...data, mode: context.config.mode }));
  }, { name: "gifts" });

  router.add("GET", "/images", async (context) => {
    const reservations = await context.read((client) => listAmbiguousReservations(client, 100));
    return context.render("Images", renderImages({ reservations, mode: context.config.mode }));
  }, { name: "images" });

  return {
    accountActions: async (context, detail) => {
      const userId = detail.account.userId;
      const data = await context.read(async (client) => ({
        entitlements: await listEntitlements(client, userId),
        giftLetters: await listGiftLetters(client, userId),
        giftCodes: await listGiftCodes(client, { userId, limit: 50 }),
        erased: (await readAccountErased(client, userId)) === true,
        erasure: await readLatestErasure(client, userId),
        followup: await readErasureFollowup(client, userId),
      }));
      const erasure = accountErasurePanel({
        userId,
        erased: data.erased,
        erasure: data.erasure,
        followup: data.followup,
        mode: context.config.mode,
      });
      // A tombstone (#289) takes no grants, gifts or unblocks: its page shows
      // the erasure's record and nothing to act on (#446 review).
      if (data.erased) return erasure;
      return join([
        accountActionPanel({ detail, entitlements: data.entitlements, mode: context.config.mode }),
        accountGiftPanel({
          userId,
          letters: data.giftLetters,
          codes: data.giftCodes,
          defaultGenerations: giftOperatorGenerationsRemaining(),
          mode: context.config.mode,
        }),
        erasure,
      ]);
    },
    orderActions: async (context, detail) => orderQuarantinePanel({ detail, mode: context.config.mode }),
  };
}
