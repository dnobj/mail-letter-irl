import type { CertifiedMailService } from "../services/types.js";

export const DELIVERY_CLASS = "USPS First-Class Mail";
export const DELIVERY_ESTIMATE =
  "Mailed in 1-2 business days; usually arrives in 1-2 weeks";
export const DELIVERY_DISCLAIMER = "USPS timing varies and can take longer.";

// Certified mail (#625): a letter goes First-Class with a certified label, signed for at delivery.
export const CERTIFIED_DELIVERY_CLASS = "USPS Certified Mail";
export const CERTIFIED_RECEIPT_DELIVERY_CLASS = "USPS Certified Mail with an electronic return receipt";
export const CERTIFIED_DELIVERY_DISCLAIMER =
  "USPS timing varies and can take longer. Certified mail is signed for at delivery; if no one signs for it or collects it from the Post Office, USPS returns it to the sender.";

/**
 * The words that say how a letter is delivered (#625): First-Class Mail unless
 * it is certified mail. The preview and get_draft_status both use this, so a
 * card told of a change of service draws the words a new preview would.
 */
export function deliveryWordsOf(service?: CertifiedMailService): { deliveryClass: string; deliveryDisclaimer: string } {
  return {
    deliveryClass: service === "certified_return_receipt" ? CERTIFIED_RECEIPT_DELIVERY_CLASS : service ? CERTIFIED_DELIVERY_CLASS : DELIVERY_CLASS,
    deliveryDisclaimer: service ? CERTIFIED_DELIVERY_DISCLAIMER : DELIVERY_DISCLAIMER
  };
}
