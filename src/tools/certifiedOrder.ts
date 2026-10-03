import type { CertifiedFacts } from '../config/certifiedMail.js';

/**
 * What to tell a person about an order that went as USPS Certified Mail
 * (#625), for get_order_status: the service, the carrier's number once there
 * is one, and where the electronic return receipt comes from.
 *
 * The number is the printer's to set: it arrives some time after the printer
 * accepts the letter, so before then the words say it is not there yet rather
 * than leave a silence. Nothing here promises a delivery or a legal effect.
 */
export function certifiedOrderNote(facts: CertifiedFacts): string {
  const service =
    facts.mailService === 'certified_return_receipt'
      ? 'USPS Certified Mail with an electronic return receipt'
      : 'USPS Certified Mail';
  const tracking =
    facts.carrierTrackingNumber && facts.carrierTrackingUrl
      ? `USPS tracking number ${facts.carrierTrackingNumber}: ${facts.carrierTrackingUrl}.`
      : 'The USPS tracking number is not here yet: the printer adds it some time after it accepts the letter, so check again later.';
  const receipt =
    facts.mailService === 'certified_return_receipt'
      ? ' The electronic return receipt is the record USPS keeps of who signed for it. Letter IRL does not receive it: ask USPS for it with the tracking number once the letter is delivered.'
      : '';
  return `Sent as ${service}. ${tracking}${receipt}`;
}
