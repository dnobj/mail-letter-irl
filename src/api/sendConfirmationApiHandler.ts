/**
 * The confirmation page's API (#470; the page itself is website #39).
 *
 *   GET  /api/sends/:draftId   the draft, as the page shows it
 *   POST /api/sends/:draftId   send it: the person pressed Send
 *
 * Only the website's own Auth0 application may call these. The REST routes
 * accept the MCP audience, so a token issued to any MCP client is valid here
 * too, and a local agent with a shell can read its own token and call the API
 * directly - which would let the model press Send for the person. The token's
 * client id names the application Auth0 issued it to, so a caller cannot
 * choose it.
 *
 * The send runs the service the send tools run (createMailOrderFromDraft, then
 * the outbox), so every check applies: letters available, the #412 duplicate
 * check, the caps, the sending switch, erasure. Its refusals are reworded for
 * the page, because the tools' wording is written for a model ("call
 * quote_and_preview_letter to create a new draft").
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { query } from '../db/index.js';
import { authenticateRestRequest, sendRestAuthFailure } from './middleware/restAuth.js';
import { rateLimitAccount } from './middleware/rateLimit.js';
import { requiredRestScopes } from '../auth/restScopes.js';
import { BETA_ACCESS_MESSAGE } from '../auth/betaAccess.js';
import { isSendConfirmationEnabled, websiteClientId } from '../config/sendConfirmation.js';
import { getDraft } from '../services/draftService.js';
import { createMailOrderFromDraft } from '../services/mailSendService.js';
import { processLetterJob } from '../services/letterJobService.js';
import { isDuplicateMailError } from '../services/duplicateMailService.js';
import { SpendLimitError } from '../services/betaSpendLimits.js';
import type { LetterDraft } from '../services/types.js';
import { isDraftIdShape } from '../tools/requestSend.js';
import {
  readRequestBody,
  RequestBodyTooLargeError,
  JSON_API_BODY_LIMIT_BYTES
} from '../utils/requestBody.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  writeDiagnostic
} from '../utils/diagnosticLog.js';

const SENDS_PREFIX = '/api/sends';
const SEND_PATH = /^\/api\/sends\/([^/]+)$/;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not_found' });
}

type DraftState = 'ready' | 'sent' | 'expired';

function draftState(draft: LetterDraft, now: Date): DraftState {
  if (draft.status === 'consumed') return 'sent';
  if (draft.status !== 'pending' || !(new Date(draft.expires_at).getTime() > now.getTime())) {
    return 'expired';
  }
  return 'ready';
}

function mailTypeOf(draft: LetterDraft): 'letter' | 'postcard' {
  return draft.mail_type === 'postcard' ? 'postcard' : 'letter';
}

const ADDRESS_FIELDS = ['name', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode'] as const;

function addressView(value: unknown): Record<string, string> {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const view: Record<string, string> = {};
  for (const field of ADDRESS_FIELDS) {
    if (typeof source[field] === 'string' && source[field]) view[field] = source[field] as string;
  }
  return view;
}

/** The letters this draft takes from the balance, as the preview tools count them. */
function lettersRequired(draft: LetterDraft): number {
  if (mailTypeOf(draft) === 'postcard') return 1;
  return Math.max(1, Math.ceil((draft.required_credits ?? 0) / 2));
}

async function lettersAvailable(userId: string): Promise<number> {
  const result = await query<{ credits: number }>(
    'SELECT credits FROM users WHERE user_id = $1',
    [userId]
  );
  return Math.floor((result.rows[0]?.credits ?? 0) / 2);
}

async function showDraft(res: ServerResponse, draft: LetterDraft, userId: string): Promise<void> {
  const state = draftState(draft, new Date());
  writeDiagnostic('info', 'send.confirmation_viewed', { mailType: mailTypeOf(draft), state });
  sendJson(res, 200, {
    draftId: draft.draft_id,
    mailType: mailTypeOf(draft),
    state,
    expiresAt: new Date(draft.expires_at).toISOString(),
    orderId: state === 'sent' ? draft.consumed_letter_id ?? null : null,
    recipient: addressView(draft.recipient),
    sender: addressView(draft.sender),
    previewHtml: draft.preview_html ?? null,
    bodyText: draft.body_text ?? '',
    signOff: draft.sign_off ?? '',
    isGiftSend: draft.is_gift_send === true,
    lettersRequired: lettersRequired(draft),
    lettersAvailable: await lettersAvailable(userId)
  });
}

interface Refusal {
  status: number;
  reason: string;
  body: Record<string, unknown>;
}

/**
 * The service's refusal, in the page's words. Only fixed strings and our own
 * numbers leave here: SpendLimitError messages are server-authored, and a
 * duplicate is described by its fields, never by a service message.
 */
export function refusalFor(error: unknown): Refusal {
  const refuse = (status: number, reason: string, message?: string, extra: Record<string, unknown> = {}): Refusal => ({
    status,
    reason,
    body: { error: reason, ...(message ? { message } : {}), ...extra }
  });

  if (isDuplicateMailError(error)) {
    const { kind, mailType, recipientName, ageSeconds } = error.duplicate;
    return refuse(409, 'duplicate', 'The same mail went out from this account in the last 24 hours.', {
      duplicate: { kind, mailType, recipientName, ageMinutes: Math.floor(Math.max(0, ageSeconds) / 60) }
    });
  }
  if (error instanceof SpendLimitError) {
    return refuse(429, 'limit', error.message);
  }
  switch ((error as { code?: unknown } | null)?.code) {
    case 'ACCOUNT_SENDS_BLOCKED':
      return refuse(403, 'blocked', 'Sending is turned off on this account. Please contact support@letterirl.com.');
    case 'BETA_ACCESS_DENIED':
      return refuse(403, 'beta', BETA_ACCESS_MESSAGE);
    case 'DRAFT_NOT_FOUND':
    case 'DRAFT_NOT_OWNED':
      return refuse(404, 'not_found');
    case 'DRAFT_EXPIRED':
    case 'DRAFT_CANCELLED':
      return refuse(410, 'expired', 'This preview has expired. Make a new preview, then send it from there.');
    case 'DRAFT_CHECKOUT_PENDING':
      return refuse(409, 'checkout_open', 'A payment for this preview is still open. Finish it, or wait for it to expire, then try again.');
    case 'GIFT_LETTERS_DISABLED':
    case 'GIFT_LETTER_UNAVAILABLE':
      return refuse(409, 'gift_unavailable', 'The gift letter for this preview is no longer available. Make a new preview.');
    case 'DRAFT_INVALID_STATE':
    case 'DRAFT_INCOMPLETE':
    case 'DRAFT_WRONG_MAIL_TYPE':
    case 'DRAFT_FUNDING_CONFLICT':
      return refuse(409, 'unsendable', "This preview can't be sent. Make a new preview, then try again.");
  }
  // The ledger's own sentence, with no code; matched on its fixed opening.
  if (error instanceof Error && /^Insufficient credits\b/.test(error.message)) {
    return refuse(402, 'no_letters', "You don't have enough letters for this. Buy letters, then come back and press Send.");
  }
  return refuse(500, 'send_failed', "We couldn't send it just now. Refresh this page to see whether it went out, then try again.");
}

async function sendDraft(req: IncomingMessage, res: ServerResponse, draft: LetterDraft, userId: string): Promise<void> {
  let body: { sendAnotherCopy?: unknown } = {};
  let raw: string;
  try {
    raw = await readRequestBody(req, { limitBytes: JSON_API_BODY_LIMIT_BYTES });
  } catch (error) {
    // Answered here: nothing between this handler and the request boundary
    // maps it, and the boundary would answer 500 (#480 review).
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: 'too_large' });
      return;
    }
    throw error;
  }
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      body = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
  }

  const mailType = mailTypeOf(draft);
  let created;
  try {
    created = await createMailOrderFromDraft({
      draftId: draft.draft_id,
      userId,
      mailType,
      allowDuplicate: body.sendAnotherCopy === true
    });
    if (!created.alreadyConsumed && !created.job) {
      throw new Error('Mail was created without an outbox record');
    }
  } catch (error) {
    const refusal = refusalFor(error);
    writeDiagnostic(refusal.status >= 500 ? 'error' : 'info', 'send.confirmation_refused', {
      mailType,
      reason: refusal.reason,
      errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'unknown_error')
    });
    sendJson(res, refusal.status, refusal.body);
    return;
  }

  // Committed: the letter exists and is paid for. Handing it to the printer
  // now is a courtesy; if that fails, the outbox sends it on its next run.
  if (!created.alreadyConsumed && created.job) {
    try {
      await processLetterJob(created.job.job_id);
    } catch (error) {
      writeDiagnostic('warn', 'send.confirmation_dispatch_deferred', {
        mailType,
        errorClass: classifyDiagnosticError(error, 'provider_error')
      });
    }
  }

  writeDiagnostic('info', 'send.confirmed_on_website', {
    mailType,
    outcome: created.alreadyConsumed ? 'already_sent' : 'sent'
  });
  sendJson(res, 200, {
    orderId: created.letter.letter_id,
    alreadySent: created.alreadyConsumed,
    lettersRemaining: Math.floor(created.creditsRemaining / 2)
  });
}

/**
 * Returns true when the request was handled, false when it is not a sends
 * route.
 */
export async function handleSendConfirmationApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname !== SENDS_PREFIX && !pathname.startsWith(`${SENDS_PREFIX}/`)) {
    return false;
  }
  const match = SEND_PATH.exec(pathname);
  // Off, the routes do not exist: the page ships with the send rule.
  if (!isSendConfirmationEnabled() || !match) {
    notFound(res);
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const auth = await authenticateRestRequest(req, requiredRestScopes(req.method, pathname));
  if (!auth.ok) {
    sendRestAuthFailure(res, auth);
    return true;
  }
  if (await rateLimitAccount(req, res, auth.user.userId, 'api_account')) {
    return true;
  }

  // Before the draft is read, so another application learns nothing.
  const website = websiteClientId();
  if (!website || auth.user.clientId !== website) {
    writeDiagnostic('warn', 'send.confirmation_client_refused', {
      configured: Boolean(website)
    });
    sendJson(res, 403, { error: 'website_only', message: 'Mail is sent from letterirl.com.' });
    return true;
  }

  let draftId: string;
  try {
    draftId = decodeURIComponent(match[1]);
  } catch {
    notFound(res);
    return true;
  }
  const draft = isDraftIdShape(draftId) ? await getDraft(draftId) : null;
  // Someone else's draft looks exactly like a missing one.
  if (!draft || draft.user_id !== auth.user.userId) {
    notFound(res);
    return true;
  }

  if (req.method === 'GET') {
    await showDraft(res, draft, auth.user.userId);
  } else {
    await sendDraft(req, res, draft, auth.user.userId);
  }
  return true;
}
