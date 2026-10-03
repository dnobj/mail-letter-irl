import type { ToolContext } from '../contracts/types.js';
import { MAIL_SERVICES, isCertifiedMailOffered } from '../config/certifiedMail.js';
import type { CertifiedMailService } from '../services/types.js';

/**
 * The mail service a letter preview asks for (#625).
 *
 * The argument is served only while certified mail is offered
 * (withheldInputKeys), but a caller can still send it, so it is checked here
 * as well: certified mail is refused while it is not offered, before any
 * picture is fetched or address checked, and the preview stays as it was.
 *
 * Standard, in any of the ways a call may leave it out or say it, is `undefined`:
 * an ordinary letter, which every reader reads as no service. Anything else
 * the schema's enum already refused, and is refused again here rather than
 * priced as standard mail.
 */
export const CERTIFIED_NOT_OFFERED =
  'Certified mail is not available right now. Leave mailService out to preview an ordinary letter.';

export function chooseMailService(requested: unknown, context: ToolContext): CertifiedMailService | undefined {
  if (requested === undefined || requested === null || requested === 'standard') return undefined;
  if (requested !== 'certified' && requested !== 'certified_return_receipt') {
    throw Object.assign(new Error(`mailService must be one of: ${MAIL_SERVICES.join(', ')}.`), {
      code: 'MAIL_SERVICE_INVALID',
      diagnosticClass: 'validation_error'
    });
  }
  if (!isCertifiedMailOffered()) {
    context.logger.info(
      { correlationId: context.correlationId, event: 'quote.letter.certified_not_offered', mailService: requested },
      'Certified mail was asked for while it is not offered'
    );
    throw Object.assign(new Error(CERTIFIED_NOT_OFFERED), {
      code: 'MAIL_SERVICE_NOT_OFFERED',
      diagnosticClass: 'validation_error'
    });
  }
  return requested;
}

/**
 * For a tool's description, while certified mail is offered: how to ask for it.
 * Otherwise nothing, and the descriptions are as before.
 */
export function certifiedMailSentence(): string {
  return isCertifiedMailOffered()
    ? 'For USPS Certified Mail, which gives a tracking number, pass mailService "certified"; "certified_return_receipt" adds an electronic return receipt. Certified mail is paid with Pay & Send, never a letter pack or a gift letter. '
    : '';
}
