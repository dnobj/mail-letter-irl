/**
 * Letter Worker
 *
 * Background worker that processes letter printing and mailing jobs
 */

import { getJobQueue } from '../services/jobQueue.js';
import { query } from '../db/index.js';
import { updateJobStatus, getJobByLetterId } from '../services/letterJobService.js';
import type { LetterJobPayload } from '../services/letterJobService.js';
import { getLetterProvider } from '../services/providers/index.js';
import type { LetterParams, PostcardParams, PostcardSize } from '../services/providers/types.js';

const LETTER_QUEUE = 'send-letter';

/**
 * Normalize country codes to US (2-letter ISO code)
 * Accept: US, USA, United States, us, usa, etc.
 */
function normalizeCountryToUS(country?: string): string {
  if (!country) return 'US';
  const normalized = country.toUpperCase().trim();
  if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'U.S.' || normalized === 'U.S.A.') {
    return 'US';
  }
  return normalized;
}

/**
 * Process a letter job
 * NOTE: pg-boss v10 passes jobs as an array for potential batch processing
 */
async function processLetterJob(jobs: any[]): Promise<void> {
  const [job] = jobs; // Destructure the array to get the single job
  const payload: LetterJobPayload = job.data;
  const { letterId, userId, content, recipient, creditsCost, mailType } = payload;

  const typeEmoji = mailType === 'postcard' ? '📮' : '📨';
  console.log(`${typeEmoji} Processing ${mailType} job: ${job.id} for letter ${letterId}`);

  // Get our internal job record
  const letterJob = await getJobByLetterId(letterId);
  if (!letterJob) {
    console.error(`❌ Letter job not found for letter ${letterId}`);
    throw new Error(`Letter job not found for letter ${letterId}`);
  }

  try {
    // Update job status to 'processing'
    await updateJobStatus(letterJob.job_id, 'processing');

    // Update letter status to 'processing'
    await query(
      `UPDATE letters SET status = $1 WHERE letter_id = $2`,
      ['processing', letterId]
    );

    // Get the letter provider (DummyProvider or real provider)
    const provider = getLetterProvider();

    let result;

    if (mailType === 'postcard') {
      // Build postcard-specific parameters
      const postcardParams: PostcardParams = {
        recipientName: recipient.name,
        recipientAddress: {
          line1: recipient.addressLine1 || '',
          line2: recipient.addressLine2,
          city: recipient.city || '',
          state: recipient.state || '',
          postalCode: recipient.postalCode || '',
          country: normalizeCountryToUS(recipient.country)
        },
        senderName: content.sender?.name,
        senderAddress: content.sender ? {
          line1: content.sender.addressLine1 || '',
          line2: content.sender.addressLine2,
          city: content.sender.city || '',
          state: content.sender.state || '',
          postalCode: content.sender.postalCode || '',
          country: normalizeCountryToUS(content.sender.country)
        } : undefined,
        frontImageBase64: content.frontImageData,
        backMessage: content.message,
        size: (content.postcardSize || '6x9') as PostcardSize,
        metadata: {
          letterId,
          userId,
          creditsCost
        }
      };

      console.log(`📮 Sending postcard via provider: ${provider.config.displayName}`);

      // Send the postcard via the provider
      result = await provider.sendPostcard(postcardParams);
    } else {
      // Build letter-specific parameters
      const letterParams: LetterParams = {
        recipientName: recipient.name,
        recipientAddress: {
          line1: recipient.addressLine1 || '',
          line2: recipient.addressLine2,
          city: recipient.city || '',
          state: recipient.state || '',
          postalCode: recipient.postalCode || '',
          country: normalizeCountryToUS(recipient.country)
        },
        senderName: content.sender?.name || 'Letter IRL',
        senderAddress: content.sender ? {
          line1: content.sender.addressLine1 || '',
          line2: content.sender.addressLine2,
          city: content.sender.city || '',
          state: content.sender.state || '',
          postalCode: content.sender.postalCode || '',
          country: normalizeCountryToUS(content.sender.country)
        } : undefined,
        message: `${content.bodyText}\n\n${content.signOff || ''}`.trim(),
        color: false,
        doubleSided: false,
        metadata: {
          letterId,
          userId,
          creditsCost
        }
      };

      console.log(`📨 Sending letter via provider: ${provider.config.displayName}`);

      // Send the letter via the provider
      result = await provider.sendLetter(letterParams);
    }

    if (!result.success) {
      throw new Error(result.error || 'Provider returned unsuccessful result');
    }

    const mailTypeLabel = mailType === 'postcard' ? 'Postcard' : 'Letter';
    console.log(`✅ ${mailTypeLabel} sent via ${provider.config.displayName}`);
    console.log(`   Tracking ID: ${result.trackingId}`);
    console.log(`   Cost: $${(result.costCents || 0) / 100}`);
    if (result.expectedDeliveryDate) {
      console.log(`   Expected Delivery: ${result.expectedDeliveryDate.toLocaleDateString()}`);
    }

    // Update letter status with provider details
    await query(
      `UPDATE letters
       SET status = $1,
           tracking_id = $2,
           provider = $3,
           cost_cents = $4,
           expected_delivery = $5,
           sent_at = NOW(),
           updated_at = NOW()
       WHERE letter_id = $6`,
      [
        'sent',
        result.trackingId,
        provider.config.name,
        result.costCents || 0,
        result.expectedDeliveryDate || null,
        letterId
      ]
    );

    // Update job status to 'completed'
    await updateJobStatus(letterJob.job_id, 'completed');

    console.log(`✅ ${mailTypeLabel} ${letterId} sent successfully (user: ${userId})`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Failed to process letter ${letterId}:`, errorMessage);

    // Update letter status to 'failed'
    await query(
      `UPDATE letters SET status = $1 WHERE letter_id = $2`,
      ['failed', letterId]
    );

    // Update job status to 'failed'
    await updateJobStatus(letterJob.job_id, 'failed', errorMessage);

    throw error; // Re-throw for pg-boss retry logic
  }
}

/**
 * Start the letter worker
 */
export async function startLetterWorker(): Promise<void> {
  const boss = getJobQueue();

  console.log('🔧 Starting letter worker...');

  // Validate provider is available
  try {
    const provider = getLetterProvider();
    const isValid = await provider.validateConnection();

    if (!isValid) {
      throw new Error('Provider connection validation failed');
    }

    console.log(`✅ Letter provider validated: ${provider.config.displayName}`);
  } catch (error) {
    console.error('❌ Failed to initialize letter provider:', error);
    throw error;
  }

  // IMPORTANT: Ensure queue exists before starting worker (pg-boss v10+)
  await boss.createQueue(LETTER_QUEUE);
  console.log(`📋 Queue "${LETTER_QUEUE}" created/verified`);

  await boss.work(
    LETTER_QUEUE,
    {
      teamSize: 5, // Process up to 5 jobs concurrently
      teamConcurrency: 1 // Each worker handles 1 job at a time
    },
    processLetterJob
  );

  console.log('✅ Letter worker started, listening for jobs on queue:', LETTER_QUEUE);
}

/**
 * Stop the letter worker (for graceful shutdown)
 */
export async function stopLetterWorker(): Promise<void> {
  const boss = getJobQueue();
  await boss.offWork(LETTER_QUEUE);
  console.log('✅ Letter worker stopped');
}
