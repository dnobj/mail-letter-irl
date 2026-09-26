import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  getAccountBalanceInputSchema,
  getAccountBalanceOutputSchema
} from "../schemas.js";
import { getBalance, getDetailedBalance } from "../services/creditService.js";
import { findUser } from "../services/userService.js";
import { getGenerationQuota } from "../services/imageGenerationLimitService.js";
import { CREDITS_PER_LETTER } from "../config/products.js";
import { getGiftBalance } from "../services/giftLetterService.js";
import { letterPacksPageUrl } from "../config/sendConfirmation.js";
import { callingApp } from "../auth/clientProfiles.js";

interface ExpiringLettersInfo {
  letters: number;
  expiresAt: string;
  daysUntilExpiry: number;
}

interface GetAccountBalanceOutput {
  lettersRemaining: number;
  canSendStandardLetter: boolean;
  message?: string;
  lettersExpiringSoon?: number;
  expiringLettersDetails?: ExpiringLettersInfo[];
  imageGenerationsRemaining?: number;
  imageGenerationsAllowance?: number;
  /** Unsent gift letters (docs/gift-letters.md). Not part of lettersRemaining. */
  giftLettersRemaining?: number;
}


async function handler(
  _input: Record<string, never>,
  context: ToolContext
): Promise<GetAccountBalanceOutput> {
  const standardCost = CREDITS_PER_LETTER;

  // Get user ID from context
  const userId = context.user.userId || 'default-user';

  // Fetch user info from database to get email
  const user = await findUser(userId);
  const email = user?.email || 'Unknown';

  // The subject prefix used to be translated into a provider name and shown
  // beside the address ("Account: you@example.com (Google)"). Auth0 mints a
  // subject per sign-in method and the post-login Action now links a person's
  // methods into one account, so that prefix names whichever method happened
  // to open the account - not the one in use, and not the only one. The
  // address is the account's identity; it is what is shown.

  // Internal credit values (2 credits = 1 letter)
  let internalCredits: number;
  let internalCreditsExpiring = 0;
  let expiringLettersDetails: ExpiringLettersInfo[] = [];

  try {
    // Get detailed balance with expiration info
    const detailedBalance = await getDetailedBalance(userId);
    internalCredits = detailedBalance.totalAvailable;
    internalCreditsExpiring = detailedBalance.expiringSoon;

    // Build expiring letters details (only include buckets that expire)
    const now = new Date();
    expiringLettersDetails = detailedBalance.expiringDates
      .filter(bucket => bucket.expiresAt !== null)
      .map(bucket => {
        const expiresAt = bucket.expiresAt as Date;
        const daysUntilExpiry = Math.ceil(
          (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        return {
          letters: Math.floor(bucket.credits / standardCost),
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiry
        };
      })
      .filter(info => info.daysUntilExpiry > 0 && info.letters > 0); // Only future expirations with at least 1 letter
  } catch (error) {
    // User doesn't exist yet or no ledger entries
    if (error instanceof Error && error.message.includes('User not found')) {
      internalCredits = 0;
    } else {
      // Try simple balance as fallback
      try {
        const balance = await getBalance(userId);
        internalCredits = balance.credits;
      } catch {
        internalCredits = 0;
      }
    }
  }

  // Convert internal credits to user-facing letters (2 credits = 1 letter)
  const lettersRemaining = Math.floor(internalCredits / standardCost);
  const lettersExpiringSoon = Math.floor(internalCreditsExpiring / standardCost);
  const canSendStandardLetter = lettersRemaining >= 1;

  // Fetch image generation quota
  let imageGenerationsRemaining: number | undefined;
  let imageGenerationsAllowance: number | undefined;
  try {
    const generationQuota = await getGenerationQuota(userId);
    imageGenerationsRemaining = generationQuota.remaining;
    imageGenerationsAllowance = generationQuota.allowance;
  } catch {
    // Ignore — user may not exist yet
  }

  // Gift letters are counted apart from the balance: a normal send never
  // spends one (docs/gift-letters.md).
  let giftLettersRemaining = 0;
  try {
    giftLettersRemaining = (await getGiftBalance(userId)).available;
  } catch {
    // Ignore, as with the image quota above
  }

  // Enhanced message with identity information
  const identityLine = `Account: ${email}`;
  let balanceLine: string;
  if (lettersRemaining === 0) {
    // Points at the conversation, not the website, where the app takes
    // purchases: create_pack_checkout and list_letter_packs (#311, #312) made
    // "go to letterirl.com" both stale and - with LETTER_IRL_PACKS_URL unset -
    // a dead end. An app that takes none, such as Claude (#475), gets the
    // dashboard page instead (#484). Claude passed on "your Letter IRL
    // dashboard" and dropped the address, so the text asks for the link.
    balanceLine = callingApp(context).inAppPurchases
      ? "No letters on this account yet. You can buy a letter pack here, or pay for a single letter as you send it."
      : `No letters on this account yet. Letter packs are bought on the Letter IRL website, not in this app. Give the person this link: ${letterPacksPageUrl()}`;
  } else {
    balanceLine = `Letter Balance: ${lettersRemaining} ${lettersRemaining === 1 ? 'letter' : 'letters'} remaining.`;
  }

  // Add expiration warning if letters are expiring soon
  let expirationWarning = '';
  if (lettersExpiringSoon > 0) {
    const earliestExpiry = expiringLettersDetails[0];
    if (earliestExpiry) {
      expirationWarning = `\n⚠️ ${lettersExpiringSoon} ${lettersExpiringSoon === 1 ? 'letter' : 'letters'} expiring in ${earliestExpiry.daysUntilExpiry} days. Use them before they expire!`;
    }
  }

  const giftLine =
    giftLettersRemaining > 0
      ? `\nGift letters: ${giftLettersRemaining}. A gift letter is free to send and adds a printed card for the recipient.`
      : '';
  const message = `${identityLine}\n${balanceLine}${giftLine}${expirationWarning}`;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "balance.lookup",
      lettersRemaining,
      lettersExpiringSoon,
      canSendStandardLetter
    },
    "Retrieved account balance from database"
  );

  return {
    lettersRemaining,
    canSendStandardLetter,
    message,
    lettersExpiringSoon: lettersExpiringSoon > 0 ? lettersExpiringSoon : undefined,
    expiringLettersDetails: expiringLettersDetails.length > 0 ? expiringLettersDetails : undefined,
    imageGenerationsRemaining,
    imageGenerationsAllowance,
    giftLettersRemaining: giftLettersRemaining > 0 ? giftLettersRemaining : undefined
  };
}

export const getAccountBalanceTool: McpToolDefinition<
  Record<string, never>,
  GetAccountBalanceOutput
> = {
  name: "get_account_balance",
  title: "Check letter balance",
  // A tool description is permanent model context - it is read every turn,
  // not only when the tool runs - so a stale route here misdirects far more
  // often than a stale message does. Claude offered a pack purchase from this
  // sentence, where purchases through connectors are not allowed (#484).
  description: (client) =>
    client.inAppPurchases
      ? "Check how many prepaid letters remain on this account. Letters can be bought without leaving the conversation: list_letter_packs shows the sizes, create_pack_checkout buys one."
      : "Check how many prepaid letters remain on this account. Letter packs are bought on the Letter IRL website, and the result gives the link when none are left.",
  readOnly: true,
  inputSchema: getAccountBalanceInputSchema,
  outputSchema: getAccountBalanceOutputSchema,
  meta: {
    "openai/toolInvocation/invoking": "Checking letter balance…",
    "openai/toolInvocation/invoked": "Balance updated",
    // The preview cards call this via window.openai.callTool to notice letters
    // arriving after a pack purchase (#306). It worked without the
    // declaration - the flag is metadata the client receives, not a
    // server-side gate - so the widget was calling an undeclared tool. Stating
    // the intent rather than relying on it not being enforced.
    "openai/widgetAccessible": true,
    readOnlyHint: true
  },
  handler
};
