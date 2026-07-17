/** Atomic draft consumption, credit deduction, letter creation, and outbox insertion. */

import { randomUUID } from 'node:crypto';
import { transaction } from '../db/index.js';
import { deductCreditsFromLedgerWithClient } from './creditLedgerService.js';
import { createLetterJobWithClient } from './letterJobService.js';
import type { Letter, LetterDraft, LetterJob, PostcardDraft } from './types.js';

export type SendMailType = 'letter' | 'postcard';

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
    inlineImageUrl: draft.inline_image_url,
  };
}

function buildPostcardContent(draft: MailDraftRow): Record<string, unknown> {
  return {
    message: draft.body_text,
    sender: draft.sender,
    frontImageData: draft.front_image_data,
    frontImageUrl: draft.front_image_url,
    postcardSize: draft.postcard_size || '6x9',
  };
}

export async function createMailOrderFromDraft(
  params: CreateMailOrderParams
): Promise<CreateMailOrderResult> {
  return transaction(async (client) => {
    const draftResult = await client.query<MailDraftRow>(
      'SELECT * FROM letter_drafts WHERE draft_id = $1 FOR UPDATE',
      [params.draftId]
    );
    const draft = draftResult.rows[0];

    if (!draft) {
      throw draftError('DRAFT_NOT_FOUND', `Draft not found: ${params.draftId}`);
    }
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
        throw draftError(
          'DRAFT_INCOMPLETE',
          `Draft ${params.draftId} was consumed without a linked order`
        );
      }

      const letterResult = await client.query<Letter>(
        'SELECT * FROM letters WHERE letter_id = $1',
        [draft.consumed_letter_id]
      );
      const userResult = await client.query<{ credits: number }>(
        'SELECT credits FROM users WHERE user_id = $1',
        [params.userId]
      );
      const letter = letterResult.rows[0];
      if (!letter) {
        throw draftError(
          'DRAFT_INCOMPLETE',
          `Draft ${params.draftId} links to a missing order`
        );
      }

      return {
        letter,
        draft,
        creditsRemaining: userResult.rows[0]?.credits ?? 0,
        alreadyConsumed: true,
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

    const letterId = randomUUID();
    const content = params.mailType === 'postcard'
      ? buildPostcardContent(draft)
      : buildLetterContent(draft);

    const letterResult = await client.query<Letter>(
      `INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status,
         preview_html, mail_type
       ) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)
       RETURNING *`,
      [
        letterId,
        params.userId,
        JSON.stringify(content),
        JSON.stringify(draft.recipient),
        draft.required_credits,
        draft.preview_html || null,
        params.mailType,
      ]
    );
    const letter = letterResult.rows[0];

    const deduction = await deductCreditsFromLedgerWithClient(client, {
      userId: params.userId,
      credits: draft.required_credits,
      letterId,
      description: `${params.mailType === 'postcard' ? 'Postcard' : 'Letter'} to ${String(draft.recipient.name || 'recipient')}`,
    });

    await client.query(
      `UPDATE letter_drafts
       SET status = 'consumed', consumed_at = NOW(), consumed_letter_id = $1, updated_at = NOW()
       WHERE draft_id = $2`,
      [letterId, params.draftId]
    );

    const job = await createLetterJobWithClient(client, letter);

    return {
      letter: { ...letter, status: 'queued' },
      draft: { ...draft, status: 'consumed', consumed_letter_id: letterId },
      job,
      creditsRemaining: deduction.user.credits,
      alreadyConsumed: false,
    };
  });
}

export function asPostcardDraft(draft: MailDraftRow): PostcardDraft {
  return draft as unknown as PostcardDraft;
}
