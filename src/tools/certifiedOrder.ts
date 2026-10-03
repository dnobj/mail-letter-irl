import type { CertifiedFacts } from '../config/certifiedMail.js';

/**
 * What to tell a person about an order that is USPS Certified Mail (#625), for
 * get_order_status: the service, the carrier's number once there is one, and
 * where the electronic return receipt comes from. What is true of the number
 * depends on where the order stands, so the words follow its status:
 *
 * - In flight (accepted, printing, in transit, delivered): the number is the
 *   printer's to set, some time after it accepts the letter, and Letter IRL's
 *   status sync stores it on its hourly run, so before then it is "not here
 *   yet, check again later".
 * - Scheduled or pending: the letter has not reached the printer, so there is
 *   no number to wait for yet.
 * - Failed or cancelled: it did not go out, no number is coming, and a
 *   return receipt would be for nothing.
 * - Returned: no number is looked for any more, and the letter will not be
 *   delivered.
 *
 * Nothing here promises a delivery or a legal effect. Where the electronic
 * return receipt is delivered is not settled (the development check is meant
 * to), so the words say only what Letter IRL does: it does not send it.
 */
export function certifiedOrderNote(facts: CertifiedFacts, status: string): string {
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
  switch (status) {
    case 'failed':
      return `Failed: it did not go out as ${name}. ${tracking ?? 'It has no USPS tracking number.'}`;
    case 'cancelled':
      return `Cancelled: it was not mailed as ${name}. ${tracking ?? 'It has no USPS tracking number.'}`;
    case 'scheduled':
    case 'pending':
      return `Goes as ${name} once it is sent to the printer. ${tracking ?? 'USPS\'s tracking number comes some time after the printer accepts it.'}${receipt}`;
    case 'returned':
      return `Sent as ${name}, and returned to the sender. ${tracking ?? 'No USPS tracking number was stored for it.'}`;
    default:
      // Accepted, printing, in transit, delivered: the sync still looks for the number.
      return `Sent as ${name}. ${tracking ?? 'The USPS tracking number is not here yet: the printer adds it some time after it accepts the letter, so check again later.'}${receipt}`;
  }
}
