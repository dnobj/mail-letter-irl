/**
 * How long a preview's draft can be sent: 3 days.
 *
 * Long enough for an agent that drafts while its person is away (an OpenAI
 * dot, a scheduled task) to hand back a send link that still works when the
 * person reads it the next day. Short enough that an unsent draft's content is
 * still deleted within the privacy policy's 7 days: the cleanup deletes it
 * UNSENT_DRAFT_DAYS_AFTER_EXPIRY after it expires (src/services/draftService.ts).
 *
 * The duplicate-mail window (src/services/duplicateMailService.ts) is this
 * same lifetime: two drafts of the same mail can both be sent for as long as
 * either lives.
 */
export const DRAFT_LIFETIME_HOURS = 72;
