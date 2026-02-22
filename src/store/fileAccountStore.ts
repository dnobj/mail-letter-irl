import { UserAccount, OrderRecord, LetterStatus } from "../contracts/types.js";
import { query } from "../db/index.js";
import { getBalance } from "../services/creditService.js";
import { getGenerationQuota } from "../services/imageGenerationLimitService.js";

interface FileStoreOptions {
  initialCredits?: number;
}

/**
 * Database-backed account store for MCP tools
 * Fetches user credits and orders from PostgreSQL
 */
export class FileAccountStore {
  private readonly initialCredits: number;

  constructor(options: FileStoreOptions = {}) {
    this.initialCredits = options.initialCredits ?? 5;
  }

  /**
   * Convert database letter status to OrderRecord status
   *
   * Database statuses: draft, queued, processing, accepted, sent, in_transit, delivered, returned, failed, cancelled
   * MCP statuses: pending, accepted, printing, in_transit, delivered, returned, failed, cancelled
   */
  private mapStatus(dbStatus: string): LetterStatus {
    switch (dbStatus) {
      // Pre-send statuses
      case 'draft':
      case 'queued':
        return 'pending';

      // PostGrid accepted order (sent is legacy, accepted is new)
      case 'sent':
      case 'accepted':
        return 'accepted';

      // Being printed
      case 'processing':
      case 'printing':
        return 'printing';

      // In the mail (PostGrid: processed_for_delivery)
      case 'in_transit':
        return 'in_transit';

      // Delivered (PostGrid: completed)
      case 'delivered':
        return 'delivered';

      // Returned to sender
      case 'returned':
        return 'returned';

      // Failed
      case 'failed':
        return 'failed';

      // Cancelled
      case 'cancelled':
        return 'cancelled';

      default:
        return 'pending';
    }
  }

  /**
   * Fetch orders from the letters table
   */
  private async fetchOrders(userId: string): Promise<OrderRecord[]> {
    try {
      const result = await query(`
        SELECT
          letter_id,
          content,
          recipient,
          credits_cost,
          status,
          preview_html,
          created_at,
          sent_at
        FROM letters
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [userId]);

      return result.rows.map((row: any) => {
        const content = row.content || {};
        const recipient = row.recipient || {};

        // Build timeline from dates
        const timeline: { timestampISO: string; statusText: string }[] = [];

        if (row.created_at) {
          timeline.push({
            timestampISO: row.created_at.toISOString(),
            statusText: 'Order placed'
          });
        }

        if (row.sent_at) {
          timeline.push({
            timestampISO: row.sent_at.toISOString(),
            statusText: 'Accepted by print facility'
          });
        }

        return {
          orderId: row.letter_id,
          snapshot: {
            sender: content.sender || {
              name: '',
              addressLine1: '',
              city: '',
              state: '',
              postalCode: '',
              country: 'US'
            },
            recipient: {
              name: recipient.name || '',
              addressLine1: recipient.addressLine1 || recipient.address1 || '',
              addressLine2: recipient.addressLine2 || recipient.address2 || '',
              city: recipient.city || '',
              state: recipient.state || '',
              postalCode: recipient.postalCode || recipient.zip || '',
              country: recipient.country || 'US'
            },
            bodyText: content.bodyText || '',
            signOff: content.signOff || '',
            requiredCredits: row.credits_cost || 1
          },
          statusTimeline: timeline,
          currentStatus: this.mapStatus(row.status),
          creditsDeducted: row.credits_cost || 1,
          recipientSummary: {
            name: recipient.name || '',
            city: recipient.city || '',
            state: recipient.state || ''
          },
          previewFirstPageHtml: row.preview_html || undefined
        } as OrderRecord;
      });
    } catch (error) {
      console.error('Error fetching orders from database:', error);
      return [];
    }
  }

  async getOrCreate(userId: string): Promise<UserAccount> {
    // Fetch credits from database
    let creditsRemaining = this.initialCredits;
    try {
      const balance = await getBalance(userId);
      creditsRemaining = balance.credits;
    } catch (error) {
      // User not found or other error - use default
      console.warn(`Could not fetch credits for ${userId}, using default:`, error);
    }

    // Fetch image generation quota
    let imageGenerationsRemaining: number | undefined;
    try {
      const quota = await getGenerationQuota(userId);
      imageGenerationsRemaining = quota.remaining;
    } catch (error) {
      // User not found or other error — leave undefined
      console.warn(`Could not fetch image generation quota for ${userId}:`, error);
    }

    // Fetch orders from database
    const orders = await this.fetchOrders(userId);

    return {
      userId,
      creditsRemaining,
      imageGenerationsRemaining,
      orders
    };
  }

  async persist(account: UserAccount): Promise<void> {
    // No-op for database-backed store
    // Orders are persisted by sendLetter tool directly to the database
    console.log(`FileAccountStore.persist called for ${account.userId} (no-op for DB store)`);
  }
}
