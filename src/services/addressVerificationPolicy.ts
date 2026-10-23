import type { AddressValidationResult } from "./providers/types.js";

/**
 * Policy for interpreting a provider address-verification result (issue #200).
 *
 * PostGrid returns status "failed" for conditions with very different
 * deliverability. The USPS DPV confirmation indicator (surfaced in
 * details.usMailingsDpvConfirmationIndicator) separates them, per the live
 * probe recorded in docs/learnings/suite-address-verification.md:
 *
 *   "Y" - fully confirmed (never reaches this policy: status is verified or
 *         corrected).
 *   "S" - the BUILDING is confirmed deliverable; the given unit (suite/apt)
 *         is not in USPS's unit list. Ordinary residential apartments land
 *         here; carriers deliver such mail routinely.
 *   "D" - the building is confirmed and normally requires a unit, but none
 *         was given (highrise default).
 *   absent - the street address itself could not be resolved.
 *
 * Blocking S/D refuses real, reachable recipients with no accepted input
 * (the #200 repro rejected every form of a suite). Policy decision (owner,
 * Aug 22 2026): S and D proceed with a warning; genuine address failures
 * still block; a verification transport failure must never masquerade as an
 * invalid address (docs/address-validation.md documents verification as
 * non-blocking when unavailable).
 */

export type AddressFailureClass = "secondary_unit" | "address_failed" | "service_error";

export type AddressOutcome = "verified" | "corrected" | "unverified" | "blocked";

export interface AddressAssessment {
  outcome: AddressOutcome;
  /** One-sentence warning to surface when proceeding without verification. */
  warning?: string;
  /** Formatted refusal text (without the tool's framing) when blocked. */
  blockText?: string;
  /**
   * The provider's corrected address, present only when outcome is
   * "corrected": the one correction a caller may put in place of the
   * address given.
   */
  correction?: CorrectedAddress;
}

export type CorrectedAddress = NonNullable<AddressValidationResult["verifiedAddress"]>;

/**
 * The state and territory codes USPS delivers to (Publication 28, Appendix
 * B), with DC, the freely associated states and the military post offices.
 */
export const US_STATE_CODES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'AS', 'GU', 'MP', 'PR', 'VI', 'FM', 'MH', 'PW', 'AA', 'AE', 'AP'
];

/** A ZIP or ZIP+4, with or without the hyphen. */
const US_ZIP = /^\d{5}(?:-?\d{4})?$/;

/**
 * Why a correction outside the U.S. is refused, as a sentence callers can
 * frame themselves.
 */
export const OUTSIDE_US_CORRECTION_REASON =
  "The address check matched this address to a place outside the U.S., and Letter IRL mails only within the U.S. " +
  "Check the street number, street name, city, state, and ZIP";

/**
 * Whether a provider's corrected address is still a U.S. one: country US or
 * USA (PostGrid answers in lower case), a USPS state or territory code, and a
 * ZIP. Letter IRL mails only within the U.S., so a correction that fails any
 * of these is never applied. A verifier answering from a test key once turned
 * a New York recipient into "TORONTO, ON M5J2N8" and the card was mailed
 * there; the address given is not used in its place either, since the check
 * said that address is not what it seems.
 */
export function isUsCorrection(address: CorrectedAddress): boolean {
  const country = (address.country ?? "").trim().toUpperCase();
  const state = (address.state ?? "").trim().toUpperCase();
  const zip = (address.postalCode ?? "").trim();
  return (country === "US" || country === "USA") && US_STATE_CODES.includes(state) && US_ZIP.test(zip);
}

function dpvIndicator(validation: AddressValidationResult): string | undefined {
  const value = validation.details?.usMailingsDpvConfirmationIndicator;
  return typeof value === "string" ? value : undefined;
}

export function classifyFailedValidation(validation: AddressValidationResult): AddressFailureClass {
  if (validation.transportError) {
    return "service_error";
  }
  const dpv = dpvIndicator(validation);
  if (dpv === "S" || dpv === "D") {
    return "secondary_unit";
  }
  // Belt and braces: PostGrid keys suite errors under "line1", so the field
  // name cannot discriminate - but the message text can, and covers any
  // response where includeDetails ever stops returning DPV data.
  if (
    validation.errors?.length &&
    validation.errors.every((e) => /suite identifier/i.test(e.message))
  ) {
    return "secondary_unit";
  }
  return "address_failed";
}

function describeUnit(validation: AddressValidationResult): string | undefined {
  const details = validation.details ?? {};
  const suiteKey = typeof details.suiteKey === "string" ? details.suiteKey : undefined;
  const suiteID = typeof details.suiteID === "string" ? details.suiteID : undefined;
  if (suiteKey && suiteID) {
    return `${suiteKey} ${suiteID}`;
  }
  return validation.originalAddress.line2?.trim() || undefined;
}

function formatSuggestion(validation: AddressValidationResult): string | undefined {
  const v = validation.verifiedAddress;
  if (!v) return undefined;
  // PostGrid echoes the input back as line1 even when nothing resolved (the
  // probe's garbage-street case), so only offer a "match" when the response
  // proved it parsed a real street.
  if (typeof validation.details?.streetName !== "string") return undefined;
  const line2 = v.line2 ? `\n   ${v.line2}` : "";
  return `   Closest match on record:\n   ${v.line1}${line2}\n   ${v.city}, ${v.state} ${v.postalCode}`;
}

/**
 * Assess one address's verification result under the policy above.
 * `label` is "Sender" or "Recipient" and appears in user-facing copy.
 */
export function assessValidation(
  label: string,
  validation: AddressValidationResult
): AddressAssessment {
  if (validation.status === "verified") {
    return { outcome: "verified" };
  }
  if (validation.status === "corrected") {
    const correction = validation.verifiedAddress;
    if (correction && !isUsCorrection(correction)) {
      return {
        outcome: "blocked",
        blockText:
          `${label} address could not be confirmed: the address check matched it to a place outside the U.S., ` +
          `and Letter IRL mails only within the U.S.` +
          `
   Check the street number, street name, city, state, and ZIP.`
      };
    }
    return correction ? { outcome: "corrected", correction } : { outcome: "corrected" };
  }

  const failureClass = classifyFailedValidation(validation);
  const who = label.toLowerCase();

  if (failureClass === "service_error") {
    return {
      outcome: "unverified",
      warning:
        `The ${who} address could not be verified right now (the verification service was unavailable), ` +
        `so it will be used exactly as entered.`
    };
  }

  if (failureClass === "secondary_unit") {
    const unit = describeUnit(validation);
    if (dpvIndicator(validation) === "D" || !validation.originalAddress.line2?.trim()) {
      return {
        outcome: "unverified",
        warning:
          `The ${who} building normally requires an apartment or suite number and none was given - ` +
          `mail will be addressed to the building. Add the unit if you have it.`
      };
    }
    return {
      outcome: "unverified",
      warning:
        `USPS couldn't confirm ${unit ? `"${unit}"` : "the unit"} at the ${who} address, but the ` +
        `building is deliverable - mail will be addressed exactly as entered.`
    };
  }

  const errorMsg =
    validation.errors?.map((e) => e.message).join("; ") || "Address is invalid or undeliverable";
  const suggestion = formatSuggestion(validation);
  return {
    outcome: "blocked",
    blockText:
      `${label} address could not be delivered to: ${errorMsg}.` +
      (suggestion ? `\n${suggestion}` : "") +
      `\n   Check the street number, street name, city, state, and ZIP.`
  };
}
