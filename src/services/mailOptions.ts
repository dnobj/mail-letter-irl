/**
 * Who pays for a piece of mail (#691): the one place the send, the checkout, the
 * confirmation page, the previews and the draft editors read a draft's mail option
 * from, and the one rule for whether a letter pack or a gift letter pays for it.
 *
 * A draft's price depends on four of its columns: its mail type, a postcard's size,
 * a letter's printed pages (migration 047, #586) and how a letter travels (052,
 * #625). A reader that loads some of them but not all prices a long letter as one
 * page, or a certified letter as a standard one. So the row draftMailOption takes
 * names all four (DraftOptionRow), and a query that reads the option selects them
 * together (DRAFT_OPTION_COLUMNS). The database holds any writer to the same rules
 * (migrations 047, 052 and 053's checks); storedPages and storedMailService refuse
 * a draft that would break them before anything is written.
 */

import { MAIL_SERVICES } from '../config/certifiedMail.js';
import { mailServiceOf, type MailOption } from '../config/products.js';
import { MAX_LETTER_PAGES } from '../render/geometry.js';
import type { Layout } from '../render/index.js';
import type { MailService, MailType, PostcardSize } from './types.js';

/** The columns of letter_drafts a draft's mail option is read from, for a query's select list. */
export const DRAFT_OPTION_COLUMNS = 'mail_type, postcard_size, pages, mail_service';

/**
 * The columns a draft's option is read from, every one of them: a row typed
 * without one does not compile, so no reader prices from part of the option.
 */
export interface DraftOptionRow {
  mail_type: string | null;
  postcard_size: string | null;
  pages: number | string | null;
  mail_service: string | null;
}

/**
 * The mail option a draft is, from its row: its mail type, a letter's printed
 * pages (migration 047, #586) and a postcard's size. Here, beside the option,
 * so the send, the checkout and the confirmation page read it alike.
 */
export function draftMailOption(draft: DraftOptionRow): MailOption {
  const mailType = (draft.mail_type || 'letter') as MailType;
  if (mailType === 'postcard') return { mailType, postcardSize: (draft.postcard_size || '6x9') as PostcardSize };
  // A SMALLINT comes back from pg as a number; anything else is read as its number.
  const pages = Number(draft.pages ?? 1);
  // The column holds only these three values (a CHECK, #625); a reader that
  // loads only part of the row must load `mail_service` too, or a certified
  // letter is priced as a standard one.
  const mailService = mailServiceOf(draft.mail_service);
  return {
    mailType,
    ...(pages > 1 ? { pages } : {}),
    ...(mailService ? { mailService } : {})
  };
}

/**
 * A letter's option for its price (#579, #586, #625): its pages, when its
 * layout runs past one, and the mail service the draft holds, when it is not
 * standard (read as the rest of the code reads a row's: mailServiceOf, so an
 * unknown value is carried and prices as nothing, never as standard mail).
 */
export function letterOption(layout: Layout | undefined, mailService?: MailService | string | null): MailOption {
  const pages = layout?.pages.length ?? 1;
  const service = mailServiceOf(mailService);
  return {
    mailType: "letter",
    ...(pages > 1 ? { pages } : {}),
    ...(service ? { mailService: service } : {})
  };
}

/**
 * Whether a letter pack or a gift letter pays for this mail (#579): a one-page
 * standard letter, in any layout and stationery, or a 6x9 postcard, the mail
 * sold before the options. Everything else is paid per send through Pay & Send,
 * at its own price. An unknown mail type is a letter, as it is priced.
 */
export function isPackPayable(option: MailOption): boolean {
  // Certified mail costs the carrier far more than a letter: never a pack's
  // (#625). Nor is a service this code does not know.
  if ((option.mailService ?? 'standard') !== 'standard') return false;
  return option.mailType === 'postcard'
    ? (option.postcardSize ?? '6x9') === '6x9'
    : (option.pages ?? 1) === 1;
}

/**
 * The pages a letter draft records (#586): one unless its preview laid it out
 * on more, and never more than the renderer lays out. More than one only on a
 * letter our renderer drew and never on a gift send, whose free letter pays
 * for one page: migration 047's checks hold any writer to that. Refused here,
 * before anything is written.
 */
export function storedPages(params: { pages?: number; rendererVersion?: string | null; isGiftSend?: boolean }): number {
  const pages = params.pages ?? 1;
  const known = Number.isInteger(pages) && pages >= 1 && pages <= MAX_LETTER_PAGES;
  if (!known || (pages > 1 && (params.rendererVersion == null || params.isGiftSend === true))) {
    // The previews lay a letter out before it gets here, so this is a defect, classed as a refusal.
    throw Object.assign(new Error('The letter cannot be stored on that many pages.'), {
      code: 'DRAFT_PAGES_INVALID',
      diagnosticClass: 'validation_error'
    });
  }
  return pages;
}

/**
 * How a letter draft travels (#625): standard unless its preview asked for
 * certified mail. A service other than standard only for a letter and never a
 * gift send, whose free letter pays for standard mail only (#579): migration
 * 052's checks hold any writer to that. Refused here, before anything is
 * written.
 */
export function storedMailService(params: { mailService?: MailService; isGiftSend?: boolean }): MailService {
  const service = params.mailService ?? 'standard';
  const known = (MAIL_SERVICES as readonly string[]).includes(service);
  if (!known || (service !== 'standard' && params.isGiftSend === true)) {
    // The previews check this before it gets here, so this is a defect, classed as a refusal.
    throw Object.assign(new Error('The letter cannot be stored with that mail service.'), {
      code: 'DRAFT_MAIL_SERVICE_INVALID',
      diagnosticClass: 'validation_error'
    });
  }
  return service;
}
