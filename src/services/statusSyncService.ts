/**
 * Status Sync Service
 *
 * Periodically syncs letter statuses from fulfillment providers (PostGrid, etc.)
 * to ensure database reflects actual delivery status.
 */

import { query } from '../db/index.js';
import { getLetterProvider } from './providers/index.js';

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

/**
 * Terminal statuses that don't need to be synced anymore
 */
const TERMINAL_STATUSES = ['delivered', 'returned', 'failed', 'cancelled'];

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
  // - Created within maxAgeInDays
  const lettersResult = await query<{
    letter_id: string;
    tracking_id: string;
    status: string;
    provider: string;
    created_at: Date;
  }>(`
    SELECT letter_id, tracking_id, status, provider, created_at
    FROM letters
    WHERE status NOT IN ('delivered', 'returned', 'failed', 'cancelled')
      AND tracking_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '${maxAgeInDays} days'
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

      // Check if status changed
      if (providerStatus.status !== letter.status) {
        console.log(`   📝 Letter ${letter.letter_id}: ${letter.status} → ${providerStatus.status}`);

        if (!dryRun) {
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`   ❌ Error syncing letter ${letter.letter_id}: ${errorMessage}`);

      result.errors++;
      result.details.push({
        letterId: letter.letter_id,
        trackingId: letter.tracking_id,
        oldStatus: letter.status,
        newStatus: letter.status,
        providerRawStatus: '',
        error: errorMessage
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
 * Useful for admin alerting
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
      EXTRACT(DAY FROM NOW() - created_at)::INTEGER as days_in_status
    FROM letters
    WHERE status NOT IN ('delivered', 'returned', 'failed', 'cancelled')
      AND tracking_id IS NOT NULL
      AND created_at < NOW() - INTERVAL '${maxDaysInNonTerminal} days'
    ORDER BY created_at ASC
  `);

  return result.rows;
}
