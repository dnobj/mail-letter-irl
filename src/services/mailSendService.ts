/** Atomic draft consumption, funding, letter creation, and outbox insertion. */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction } from '../db/index.js';
import { deductCreditsFromLedgerWithClient } from './creditLedgerService.js';
import { createLetterJobWithClient } from './letterJobService.js';
import type { Letter, LetterDraft, LetterJob, Order, PostcardDraft } from './types.js';

export type SendMailType = 'letter' | 'postcard';

export type MailFunding =
  | { type: 'prepaid_balance'; requiredCredits?: number }
  | { type: 'jit_order'; orderId: string };

interface MailDraftRow extends LetterDraft {
  mail_type: SendMailType;
  front_image_data?: string;
  front_image_url?: string;
  postcard_size?: string;
}

export interface CreateMailOrderParams {
  draftId: string;
  userId: string;
  mailType: SendMailType;
  funding?: MailFunding;
}

export interface CreateMailOrderResult {
  letter: Letter;
  draft: MailDraftRow;
  job?: LetterJob;
  creditsRemaining: number;
  alreadyConsumed: boolean;
}

function draftError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function buildLetterContent(draft: MailDraftRow): Record<string, unknown> {
  return {
    bodyText: draft.body_text,
    signOff: draft.sign_off,
    sender: draft.sender,
    layoutType: draft.layout_type || 'text_only',
    headerImageData: draft.header_image_data,
    headerImageUrl: draft.header_image_url,
    inlineImageData: draft.inline_image_data,
    inlineImageUrl: draft.inline_image_url
  };
}

function buildPostcardContent(draft: MailDraftRow): Record<string, unknown> {
  return {
    message: draft.body_text,
    sender: draft.sender,
    frontImageData: draft.front_image_data,
    frontImageUrl: draft.front_image_url,
    postcardSize: draft.postcard_size || '6x9'
  };
}

async function loadCreditsRemaining(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string
): Promise<number> {
  const result = await client.query<{ credits: number }>(
    'SELECT credits FROM users WHERE user_id = $1',
    [userId]
  );
  return result.rows[0]?.credits ?? 0;
}

/** Execute mail creation inside a caller-owned transaction. */
export async function createMailOrderFromDraftWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  params: CreateMailOrderParams
): Promise<CreateMailOrderResult> {
  const funding = params.funding || { type: 'prepaid_balance' as const };
  const draftResult = await client.query<MailDraftRow>(
    'SELECT * FROM letter_drafts WHERE draft_id = $1 FOR UPDATE',
    [params.draftId]
  );
  const draft = draftResult.rows[0];

  if (!draft) throw draftError('DRAFT_NOT_FOUND', `Draft not found: ${params.draftId}`);
  if (draft.user_id !== params.userId) {
    throw draftError('DRAFT_NOT_OWNED', `Draft ${params.draftId} does not belong to this user`);
  }

  const actualMailType = draft.mail_type || 'letter';
  if (actualMailType !== params.mailType) {
    throw draftError(
      'DRAFT_WRONG_MAIL_TYPE',
      `Draft ${params.draftId} is a ${actualMailType}, not a ${params.mailType}`
    );
  }

  if (draft.status === 'consumed') {
    if (!draft.consumed_letter_id) {
      throw draftError('DRAFT_INCOMPLETE', `Draft ${params.draftId} has no linked mail item`);
    }
    const letterResult = await client.query<Letter>('SELECT * FROM letters WHERE letter_id = $1', [
      draft.consumed_letter_id
    ]);
    if (!letterResult.rows[0]) {
      throw draftError('DRAFT_INCOMPLETE', `Draft ${params.draftId} links to missing mail`);
    }
    const existingLetter = letterResult.rows[0];
    if (
      funding.type === 'jit_order' &&
      (existingLetter.funding_type !== 'jit_order' ||
        existingLetter.funding_order_id !== funding.orderId)
    ) {
      throw draftError(
        'DRAFT_FUNDING_CONFLICT',
        `Draft ${params.draftId} was already consumed by different funding`
      );
    }
    return {
      letter: existingLetter,
      draft,
      creditsRemaining: await loadCreditsRemaining(client, params.userId),
      alreadyConsumed: true
    };
  }

  if (draft.status === 'expired' || new Date(draft.expires_at).getTime() <= Date.now()) {
    throw draftError('DRAFT_EXPIRED', `Draft expired: ${params.draftId}`);
  }
  if (draft.status === 'cancelled') {
    throw draftError('DRAFT_CANCELLED', `Draft was cancelled: ${params.draftId}`);
  }
  if (draft.status !== 'pending') {
    throw draftError('DRAFT_INVALID_STATE', `Draft ${params.draftId} is ${draft.status}`);
  }

  let jitOrder: Order | undefined;
  if (funding.type === 'prepaid_balance') {
    const activeCheckout = await client.query<{ order_id: string }>(
      `SELECT order_id FROM orders
       WHERE draft_id = $1
         AND order_type = 'jit_mail'
         AND status IN ('checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending')
         AND (status <> 'checkout_pending' OR checkout_expires_at IS NULL OR checkout_expires_at > NOW())
       LIMIT 1
       FOR UPDATE`,
      [params.draftId]
    );
    if (activeCheckout.rows[0]) {
      throw draftError(
        'DRAFT_CHECKOUT_PENDING',
        `Draft ${params.draftId} has an active Pay & Send checkout`
      );
    }
  } else {
    const orderResult = await client.query<Order>(
      'SELECT * FROM orders WHERE order_id = $1 FOR UPDATE',
      [funding.orderId]
    );
    jitOrder = orderResult.rows[0];
    if (!jitOrder) throw draftError('JIT_ORDER_NOT_FOUND', `Order not found: ${funding.orderId}`);
    if (jitOrder.order_type !== 'jit_mail') {
      throw draftError('JIT_ORDER_INVALID', `Order ${funding.orderId} is not a JIT order`);
    }
    if (jitOrder.user_id !== params.userId || jitOrder.draft_id !== params.draftId) {
      throw draftError(
        'JIT_ORDER_NOT_OWNED',
        'JIT order ownership or draft binding does not match'
      );
    }
    if (jitOrder.status !== 'paid') {
      throw draftError('JIT_ORDER_NOT_PAID', `Order ${funding.orderId} is ${jitOrder.status}`);
    }
  }

  const letterId = randomUUID();
  const content =
    params.mailType === 'postcard' ? buildPostcardContent(draft) : buildLetterContent(draft);
  const fundingType = funding.type === 'jit_order' ? 'jit_order' : 'prepaid_balance';

  const letterResult = await client.query<Letter>(
    `INSERT INTO letters (
       letter_id, user_id, content, recipient, credits_cost, status,
       preview_html, mail_type, funding_type, funding_order_id
     ) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9)
     RETURNING *`,
    [
      letterId,
      params.userId,
      JSON.stringify(content),
      JSON.stringify(draft.recipient),
      draft.required_credits,
      draft.preview_html || null,
      params.mailType,
      fundingType,
      funding.type === 'jit_order' ? funding.orderId : null
    ]
  );
  const letter = letterResult.rows[0];

  let creditsRemaining: number;
  if (funding.type === 'prepaid_balance') {
    const requiredCredits = funding.requiredCredits ?? draft.required_credits;
    if (requiredCredits !== draft.required_credits) {
      throw draftError('FUNDING_AMOUNT_MISMATCH', 'Prepaid funding does not match the draft');
    }
    const deduction = await deductCreditsFromLedgerWithClient(client as pg.PoolClient, {
      userId: params.userId,
      credits: requiredCredits,
      letterId,
      description: `${params.mailType === 'postcard' ? 'Postcard' : 'Letter'} to ${String(draft.recipient.name || 'recipient')}`
    });
    creditsRemaining = deduction.user.credits;
  } else {
    creditsRemaining = await loadCreditsRemaining(client, params.userId);
  }

  await client.query(
    `UPDATE letter_drafts
     SET status = 'consumed', consumed_at = NOW(), consumed_letter_id = $1, updated_at = NOW()
     WHERE draft_id = $2`,
    [letterId, params.draftId]
  );
  const job = await createLetterJobWithClient(client as pg.PoolClient, letter);

  if (jitOrder) {
    await client.query(
      `UPDATE orders
       SET status = 'fulfillment_pending', letter_id = $1,
           fulfillment_started_at = COALESCE(fulfillment_started_at, NOW()),
           last_error_code = NULL, last_error = NULL, updated_at = NOW()
       WHERE order_id = $2`,
      [letterId, jitOrder.order_id]
    );
  }

  return {
    letter: { ...letter, status: 'queued' },
    draft: { ...draft, status: 'consumed', consumed_letter_id: letterId },
    job,
    creditsRemaining,
    alreadyConsumed: false
  };
}

export async function createMailOrderFromDraft(
  params: CreateMailOrderParams
): Promise<CreateMailOrderResult> {
  return transaction(client => createMailOrderFromDraftWithClient(client, params));
}

export function asPostcardDraft(draft: MailDraftRow): PostcardDraft {
  return draft as unknown as PostcardDraft;
}
