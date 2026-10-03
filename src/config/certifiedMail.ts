import { CERTIFIED_MAIL_FLAG, isExtraService, isJitPurchaseEnabled, mailServiceOf } from './products.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';
import type { CertifiedMailService, MailService } from '../services/types.js';

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

/**
 * Where USPS shows a piece's progress, from its tracking number. The number is
 * stored as the printer sent it, in groups that may be separated by spaces or
 * hyphens; USPS wants the characters alone.
 */
export function uspsTrackingUrl(carrierNumber: string): string {
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(carrierNumber.replace(/[ -]/g, ''))}`;
}

/**
 * What a sent letter's row says about certified mail (#625), for the readers
 * that show an order: the service, and the carrier's number and its link once
 * there is one (the status sync stores it some time after the printer accepts
 * the letter).
 */
export interface CertifiedFacts {
  mailService: CertifiedMailService;
  carrierTrackingNumber?: string;
  carrierTrackingUrl?: string;
}

/**
 * The certified facts of a letter row, or none for an ordinary letter.
 *
 * This only decides whether an order says anything about certified mail; it
 * prices nothing, so text that is not one of the two services (which the
 * column's CHECK keeps out of the table) says nothing rather than something
 * invented. The row's number is shown only beside a certified service and only
 * as non-empty text, whatever the column holds.
 */
export function certifiedFactsOf(row: { mail_service?: unknown; carrier_tracking_number?: unknown }): CertifiedFacts | undefined {
  const service = mailServiceOf(typeof row.mail_service === 'string' ? row.mail_service : null);
  if (!isExtraService(service)) return undefined;
  const number = typeof row.carrier_tracking_number === 'string' ? row.carrier_tracking_number.trim() : '';
  return {
    mailService: service,
    ...(number === '' ? {} : { carrierTrackingNumber: number, carrierTrackingUrl: uspsTrackingUrl(number) })
  };
}
