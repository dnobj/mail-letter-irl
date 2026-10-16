import type { ClientProfile } from "../auth/clientProfiles.js";

/**
 * Letter IRL's own image generation (generate_image_for_mail, #227) and its
 * switch, LETTER_IRL_IMAGE_GEN_MODE.
 *
 * - `on`, the default: generates while the account has image generations
 *   left, and hands back the redirect card otherwise.
 * - `mobile_only`: generates only where the app reports a phone.
 * - `redirect`: never generates. The tool stays listed and always hands back
 *   the redirect card; this is what `off` meant before.
 * - `off`: the feature is gone. No app is offered the tool, no purchase grants
 *   image generations, and nothing reports how many are left. To bring it
 *   back, set `on` again (or remove the variable) and redeploy. Generations
 *   granted before the switch are kept, and nothing is backfilled for
 *   purchases made while it was off.
 *
 * An unknown value reads as `on`, as it always has.
 */
export type ImageGenMode = "on" | "off" | "redirect" | "mobile_only";

export function imageGenMode(env: NodeJS.ProcessEnv = process.env): ImageGenMode {
  const raw = (env.LETTER_IRL_IMAGE_GEN_MODE ?? "on").trim().toLowerCase();
  return raw === "off" || raw === "redirect" || raw === "mobile_only" ? raw : "on";
}

/** The whole feature is switched off: no tool, no grants, no counts. */
export function isImageGenerationOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return imageGenMode(env) === "off";
}

/**
 * Whether this app is offered Letter IRL's image generation at all: allowed
 * for the app (not in Claude, #490), and not switched off.
 */
export function offersImageGeneration(
  client: ClientProfile,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return client.offersImageGeneration && !isImageGenerationOff(env);
}
