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
 * invalid address (docs/ADDRESS-VALIDATION.md documents verification as
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
    return { outcome: "corrected" };
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
