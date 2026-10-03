import type { CertifiedFacts } from '../config/certifiedMail.js';
import type { LetterStatus } from '../contracts/types.js';

/**
 * What to tell a person about an order that is USPS Certified Mail (#625), for
 * get_order_status: the service, the carrier's number once there is one, and
 * where the electronic return receipt comes from. What is true of the number
 * depends on where the order stands, so the words follow its status:
 *
 * - In flight (accepted, printing, in transit, delivered): the number is the
 *   printer's to set, some time after it accepts the letter, and Letter IRL's
 *   provider status sync (every six hours, for a month after the send) stores
 *   it, so before then it is "not here yet, check again later".
 * - Scheduled or pending: the number comes after the printer accepts the
 *   letter, so there is none to wait for yet. (Pending also covers a letter
 *   held for an operator, so nothing here says it has reached the printer.)
 * - Failed or cancelled: it did not go out, no number is coming, and a
 *   return receipt would be for nothing.
 * - Returned: no number is looked for any more, and the letter will not be
 *   delivered.
 *
 * The switch covers every LetterStatus, so a new status makes the compiler ask
 * for its words; a status this code has never heard of (data newer than the
 * code) is worded as the printer having the letter.
 *
 * Nothing here promises a delivery or a legal effect. Where the electronic
 * return receipt is delivered is not settled (the development check is meant
 * to), so the words say only what Letter IRL does: it does not send it.
 */
export function certifiedOrderNote(facts: CertifiedFacts, status: LetterStatus): string {
  const name =
    facts.mailService === 'certified_return_receipt'
      ? 'USPS Certified Mail with an electronic return receipt'
      : 'USPS Certified Mail';
  const tracking =
    facts.carrierTrackingNumber && facts.carrierTrackingUrl
      ? `USPS tracking number ${facts.carrierTrackingNumber}: ${facts.carrierTrackingUrl}.`
      : null;
  const receipt =
    facts.mailService === 'certified_return_receipt'
      ? ' The electronic return receipt is the record USPS keeps of who signed for the letter. Letter IRL does not send it to you: once the letter is delivered, ask USPS for it with the tracking number.'
      : '';
  const printerHasIt = (): string =>
    `Sent as ${name}. ${tracking ?? 'The USPS tracking number is not here yet: the printer adds it some time after it accepts the letter, so check again later.'}${receipt}`;
  switch (status) {
    case 'failed':
      return `This ${name} letter did not go out. ${tracking ?? 'It has no USPS tracking number.'}`;
    case 'cancelled':
      return `This ${name} letter was cancelled and not mailed. ${tracking ?? 'It has no USPS tracking number.'}`;
    case 'scheduled':
    case 'pending':
      return `Goes as ${name}. ${tracking ?? 'USPS\'s tracking number comes some time after the printer accepts it.'}${receipt}`;
    case 'returned':
      return `Sent as ${name}, and returned to the sender. ${tracking ?? 'No USPS tracking number was stored for it.'}`;
    case 'accepted':
    case 'printing':
    case 'in_transit':
    case 'delivered':
      return printerHasIt();
    default: {
      const unknown: never = status;
      void unknown;
      return printerHasIt();
    }
  }
}
