import { CERTIFIED_MAIL_FLAG, isJitPurchaseEnabled } from './products.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';
import type { MailService } from '../services/types.js';

/**
 * Certified mail (#625): a letter sent as USPS Certified Mail, with or without
 * an electronic return receipt. PostGrid sells it as one request field,
 * `extraService`, on a US first-class letter; the carrier's tracking number
 * arrives later, once USPS has the piece.
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

/** The values a letter preview takes for `mailService`, in the order they are offered. */
export const MAIL_SERVICES = ['standard', 'certified', 'certified_return_receipt'] as const;

/**
 * Compile-time checks that the list above is exactly the MailService union:
 * every listed value is a service, and every service is listed.
 */
type UnlistedService = Exclude<MailService, (typeof MAIL_SERVICES)[number]>;
const _everyServiceIsListed: [UnlistedService] extends [never] ? true : never = true;
const _everyListedValueIsAService: readonly MailService[] = MAIL_SERVICES;
void _everyServiceIsListed;
void _everyListedValueIsAService;

/**
 * Whether the letter previews offer certified mail: the flag is on (it also
 * sells the two Pay & Send prices, #578), and Pay & Send is on, since nothing
 * else pays for it (#579). Off, every letter travels standard, as before. A
 * letter already previewed as certified still sends as certified: the send and
 * the print read the draft's own service, never this.
 */
export function isCertifiedMailOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled(CERTIFIED_MAIL_FLAG, env) && isJitPurchaseEnabled(env);
}
