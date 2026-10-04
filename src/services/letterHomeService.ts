import { query } from '../db/index.js';
import { certifiedFactsOf } from '../config/certifiedMail.js';
import { sendConfirmationUrl } from '../config/sendConfirmation.js';
import { certifiedOrderNote } from '../tools/certifiedOrder.js';
import type { LetterStatus } from '../contracts/types.js';

export const HOME_LIMIT = 20;

interface HomeRow {
  kind: 'draft' | 'order';
  id: string;
  name: string | null;
  city: string | null;
  state: string | null;
  status: string;
  created_at: Date;
  expires_at: Date | null;
  arrive_by: string | null;
  mail_on: string | null;
  mail_type: string;
  mail_service: string;
  carrier_tracking_number: string | null;
  is_gift_send: boolean;
}

const homeStatus = (status: string, scheduled: boolean): LetterStatus => {
  switch (status) {
    case 'queued': return scheduled ? 'scheduled' : 'pending';
    case 'draft': return 'pending';
    case 'processing': return 'printing';
    case 'sent': return 'accepted';
    case 'accepted': case 'printing': case 'in_transit': case 'delivered':
    case 'returned': case 'failed': case 'cancelled': return status;
    default: return 'pending';
  }
};

/** One read gives both lists the same snapshot. Never fetch content or street addresses. */
export async function readLetterHome(userId: string) {
  const result = await query<HomeRow>(
    `SELECT * FROM (
       SELECT 'draft' AS kind, draft_id::text AS id,
              recipient->>'name' AS name, recipient->>'city' AS city, recipient->>'state' AS state,
              status::text, created_at, expires_at, arrive_by, mail_on, mail_type,
              mail_service, NULL::text AS carrier_tracking_number, is_gift_send
         FROM letter_drafts
        WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW() AND redacted_at IS NULL
        ORDER BY created_at DESC, draft_id DESC LIMIT $2
     ) drafts
     UNION ALL
     SELECT * FROM (
       SELECT 'order' AS kind, letter_id::text AS id,
              recipient->>'name' AS name, recipient->>'city' AS city, recipient->>'state' AS state,
              status::text, created_at, NULL::timestamptz AS expires_at, arrive_by, mail_on, mail_type,
              mail_service, carrier_tracking_number, funding_type = 'gift_letter' AS is_gift_send
         FROM letters
        WHERE user_id = $1 AND redacted_at IS NULL
        ORDER BY created_at DESC, letter_id DESC LIMIT $2
     ) orders`,
    [userId, HOME_LIMIT]
  );
  const recipient = (row: HomeRow) => ({ name: row.name ?? '', city: row.city ?? '', state: row.state ?? '' });
  const dates = (row: HomeRow) => row.arrive_by && row.mail_on ? { arriveBy: row.arrive_by, mailOn: row.mail_on } : {};
  const drafts = result.rows.filter(row => row.kind === 'draft').map(row => ({
    draftId: row.id,
    recipient: recipient(row),
    mailType: row.mail_type === 'postcard' ? 'postcard' as const : 'letter' as const,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at!.toISOString(),
    confirmationUrl: sendConfirmationUrl(row.id),
    isGiftSend: row.is_gift_send,
    ...dates(row)
  }));
  const orders = result.rows.filter(row => row.kind === 'order').map(row => {
    const status = homeStatus(row.status, Boolean(row.arrive_by && row.mail_on));
    const certified = certifiedFactsOf(row);
    return {
      orderId: row.id,
      recipient: recipient(row),
      mailType: row.mail_type === 'postcard' ? 'postcard' as const : 'letter' as const,
      status,
      createdAt: row.created_at.toISOString(),
      isGiftSend: row.is_gift_send,
      ...dates(row),
      ...(certified ? { ...certified, certifiedNote: certifiedOrderNote(certified, status) } : {})
    };
  });
  const recipients = [...new Map(orders.map(order => [JSON.stringify(order.recipient), order.recipient])).values()];
  return { drafts, orders, recipients, limit: HOME_LIMIT };
}
