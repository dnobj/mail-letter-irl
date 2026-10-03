/**
 * Status Sync Service
 *
 * Periodically syncs letter statuses from fulfillment providers (PostGrid, etc.)
 * to ensure database reflects actual delivery status.
 */

import { query } from '../db/index.js';
import { getLetterProvider } from './providers/index.js';
import { failProviderCancelledLetter } from './letterJobService.js';
import { carriedDiagnosticClass, classifyDiagnosticError } from '../utils/diagnosticLog.js';

export interface StatusSyncResult {
  checked: number;
  updated: number;
  errors: number;
  details: StatusSyncDetail[];
}

export interface StatusSyncDetail {
  letterId: string;
  trackingId: string;
  oldStatus: string;
  newStatus: string;
  providerRawStatus: string;
  error?: string;
}

// Terminal statuses are not synced: the query below skips the same list as
// letterJobService's ENDED_LETTER_STATUSES, which failProviderCancelledLetter
// leaves as they are. The one exception is a certified letter delivered before
// its carrier number was stored (#625): it is read for the number alone, and its
// status is left as it is.

/**
 * Sync letter statuses from the fulfillment provider
 *
 * @param dryRun - If true, don't update database, just report what would change
 * @param maxAgeInDays - Only check letters created within this many days (default: 30)
 * @returns Sync results with details of what was updated
 */
export async function syncLetterStatuses(
  dryRun: boolean = false,
  maxAgeInDays: number = 30
): Promise<StatusSyncResult> {
  console.log(`📊 Starting status sync (dryRun: ${dryRun}, maxAge: ${maxAgeInDays} days)`);

  const result: StatusSyncResult = {
    checked: 0,
    updated: 0,
    errors: 0,
    details: []
  };

  // Get provider
  const provider = getLetterProvider();
  console.log(`   Provider: ${provider.config.displayName}`);

  // Query letters that need status sync:
  // - Not in terminal status
  // - Have a tracking_id (were sent to provider)
  // - Mailed within maxAgeInDays: counted from sent_at, when the provider took
  //   it, so a letter held for weeks to arrive by a date (#535) is still
  //   followed after it mails; created_at for one not yet marked sent
  // - Or a certified letter (#625) that was delivered before its USPS number
  //   was stored: the number is the point of the service, so it is still asked
  //   for until it is had (inside the same window)
  const lettersResult = await query<{
    letter_id: string;
    tracking_id: string;
    status: string;
    provider: string;
    created_at: Date;
    mail_service: string | null;
    carrier_tracking_number: string | null;
  }>(`
    SELECT letter_id, tracking_id, status, provider, created_at,
           mail_service, carrier_tracking_number
    FROM letters
    WHERE (
        status NOT IN ('delivered', 'returned', 'failed', 'cancelled')
        OR (status = 'delivered' AND mail_service <> 'standard' AND carrier_tracking_number IS NULL)
      )
      AND tracking_id IS NOT NULL
      AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '${maxAgeInDays} days'
    ORDER BY created_at DESC
  `);

  const letters = lettersResult.rows;
  console.log(`   Found ${letters.length} letters to check`);

  for (const letter of letters) {
    result.checked++;

    try {
      // Get status from provider
      const providerStatus = await provider.getStatus(letter.tracking_id);

      const detail: StatusSyncDetail = {
        letterId: letter.letter_id,
        trackingId: letter.tracking_id,
        oldStatus: letter.status,
        newStatus: providerStatus.status,
        providerRawStatus: providerStatus.statusMessage
      };

      // The USPS number of a certified letter (#625). The carrier sets it some
      // time after it takes the letter, usually without a change of status, so
      // it is stored on its own and not only when the status moves. Standard
      // mail has none (the column's CHECK holds that too).
      const carrierNumber = providerStatus.carrierTrackingNumber;
      if (
        !dryRun &&
        carrierNumber &&
        letter.mail_service &&
        letter.mail_service !== 'standard' &&
        letter.carrier_tracking_number !== carrierNumber
      ) {
        // In a block of its own: a number that cannot be stored never holds back
        // the letter's status (a cancel, a delivery), and the next run tries again.
        try {
          await query(
            `UPDATE letters
             SET carrier_tracking_number = $2::text, updated_at = NOW()
             WHERE letter_id = $1
               AND mail_service <> 'standard'
               AND carrier_tracking_number IS DISTINCT FROM $2::text`,
            [letter.letter_id, carrierNumber]
          );
        } catch (error) {
          // A class, never the database's text (#394).
          result.errors++;
          result.details.push({
            ...detail,
            newStatus: letter.status,
            providerRawStatus: '',
            error: `carrier_number_not_stored:${carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'database_error')}`
          });
        }
      }

      // A delivered letter is read for its number alone (above): its status is
      // final, whatever the provider now answers.
      if (letter.status === 'delivered') continue;

      // Check if status changed
      if (providerStatus.status !== letter.status) {
        console.log(`   📝 Letter status updated: ${letter.status} → ${providerStatus.status}`);

        if (!dryRun && providerStatus.status === 'failed') {
          // Cancelled by the provider before printing (#566): the letter fails
          // and what paid for it comes back, once, under the outbox's locks.
          // Ended meanwhile, it is left as it is and not counted.
          const outcome = await failProviderCancelledLetter({
            letterId: letter.letter_id,
            providerRawStatus: providerStatus.statusMessage
          });
          if (outcome === 'unchanged') continue;
        } else if (!dryRun) {
          // Update current status
          await query(
            `UPDATE letters
             SET status = $1,
                 status_updated_at = NOW(),
                 provider_raw_status = $2,
                 updated_at = NOW()
             WHERE letter_id = $3`,
            [providerStatus.status, providerStatus.statusMessage, letter.letter_id]
          );

          // Record status change in history
          await query(
            `INSERT INTO letter_status_history
             (letter_id, old_status, new_status, provider_raw_status, source)
             VALUES ($1, $2, $3, $4, 'sync')`,
            [letter.letter_id, letter.status, providerStatus.status, providerStatus.statusMessage]
          );
        }

        result.updated++;
        result.details.push(detail);
      }
    } catch (error) {
      // A class, never the provider's message: the status-sync command copies
      // this detail into admin_command_runs and the audit row (#394).
      // A class, never the provider's message: the status-sync command copies
      // this detail into admin_command_runs and the audit row (#394). The
      // provider's getStatus wraps every failure in a plain Error, so this is
      // provider_error unless a lower layer attached a class.
      const errorClass = carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error');
      console.error('   ❌ Error syncing letter');

      result.errors++;
      result.details.push({
        letterId: letter.letter_id,
        trackingId: letter.tracking_id,
        oldStatus: letter.status,
        newStatus: letter.status,
        providerRawStatus: '',
        error: errorClass
      });
    }
  }

  console.log(`✅ Status sync complete: checked=${result.checked}, updated=${result.updated}, errors=${result.errors}`);

  return result;
}

/**
 * Get status history for a specific letter
 */
export async function getLetterStatusHistory(
  letterId: string
): Promise<Array<{
  old_status: string | null;
  new_status: string;
  provider_raw_status: string | null;
  source: string;
  changed_at: Date;
}>> {
  const result = await query<{
    old_status: string | null;
    new_status: string;
    provider_raw_status: string | null;
    source: string;
    changed_at: Date;
  }>(`
    SELECT old_status, new_status, provider_raw_status, source, changed_at
    FROM letter_status_history
    WHERE letter_id = $1
    ORDER BY changed_at ASC
  `, [letterId]);

  return result.rows;
}

/**
 * Get letters that are stuck in non-terminal status for too long
 * Useful for admin alerting. Counted from when the provider took the letter
 * (sent_at), so held mail (#535) is not stuck for the weeks it waited.
 */
export async function getStuckLetters(
  maxDaysInNonTerminal: number = 14
): Promise<Array<{
  letter_id: string;
  tracking_id: string;
  status: string;
  created_at: Date;
  days_in_status: number;
}>> {
  const result = await query<{
    letter_id: string;
    tracking_id: string;
    status: string;
    created_at: Date;
    days_in_status: number;
  }>(`
    SELECT
      letter_id,
      tracking_id,
      status,
      created_at,
      EXTRACT(DAY FROM NOW() - COALESCE(sent_at, created_at))::INTEGER as days_in_status
    FROM letters
    WHERE status NOT IN ('delivered', 'returned', 'failed', 'cancelled')
      AND tracking_id IS NOT NULL
      AND COALESCE(sent_at, created_at) < NOW() - INTERVAL '${maxDaysInNonTerminal} days'
    ORDER BY COALESCE(sent_at, created_at) ASC
  `);

  return result.rows;
}
