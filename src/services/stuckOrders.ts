/**
 * Pay & Send orders stuck in a state that should pass within minutes: paid,
 * being fulfilled or being refunded for 30 minutes or more. The hourly
 * maintenance logs commerce.stuck_orders_detected on it
 * (commerceService.runCommerceMaintenance) and the admin panel's health counts
 * it (src/admin/queries/maintenance.ts), so the two always agree.
 *
 * A held letter's order (#535) waits in fulfillment_pending until the letter
 * goes to the printer on its mail date, which can be weeks. It is not stuck
 * while its hold lasts, nor for 90 minutes after, while the hourly run gets to
 * it; after that it is. A held job carries metadata.heldUntil, the end of its
 * hold (letterJobService.createLetterJobWithClient), which the admin's reader
 * role can read: it reads letter_jobs whole, but not letters.mail_on.
 *
 * A SQL condition on `orders`, to put in a WHERE or a FILTER.
 */
export const STUCK_ORDER_CONDITION = `status IN ('paid', 'fulfillment_pending', 'refund_pending')
       AND updated_at < NOW() - INTERVAL '30 minutes'
       AND NOT (
         status = 'fulfillment_pending'
         AND EXISTS (
           SELECT 1
             FROM letters held
             JOIN letter_jobs held_job ON held_job.letter_id = held.letter_id
            WHERE held.funding_order_id = orders.order_id
              AND held.status = 'queued'
              AND held_job.metadata->>'heldUntil' IS NOT NULL
              AND (held_job.metadata->>'heldUntil')::timestamptz > NOW() - INTERVAL '90 minutes'
         )
       )`;
