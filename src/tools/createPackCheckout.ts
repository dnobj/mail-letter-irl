import { carriedDiagnosticClass, isTerminalDiagnosticClass } from '../utils/diagnosticLog.js';
import {
  PACK_CHOICES,
  PACK_PRODUCTS,
  formatAmountForCurrency,
  type PackChoice,
  type PackProductId
} from '../config/products.js';
import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { widgetTemplateUri } from '../mcp/widgetUris.js';
import { createPackCheckoutInputSchema, createPackCheckoutOutputSchema } from '../schemas.js';
import { createPackCheckout } from '../services/commerceService.js';
import { findUser } from '../services/userService.js';

interface CreatePackCheckoutInput {
  pack: PackChoice;
}

interface CreatePackCheckoutOutput {
  orderId: string;
  checkoutUrl?: string;
  letters: number;
  amountCents: number;
  currency: string;
  /** Server-formatted price, e.g. "5.00", so the card never recomputes it. */
  displayAmount: string;
  productDescription: string;
  expiresAt?: string;
  status: string;
  reused: boolean;
  message: string;
}

/**
 * The card that renders this tool's result (issue #322). Until 2026-09-12 the
 * tool had no output template: called from a widget button the customer got a
 * link, but called from a text prompt nothing rendered and the model was left
 * to relay a 500-character Stripe URL in prose. In production it twice
 * described a checkout as "ready" or "shown above" with no link at all, once
 * with a fabricated URL. The card carries the real anchor.
 */
const OUTPUT_TEMPLATE = widgetTemplateUri("PackCheckoutCard");

/**
 * Customer-safe text for a failed pack checkout.
 *
 * Deliberately parallel to friendlyCheckoutError in createMailCheckout.ts,
 * including its handling of carried diagnostic classes: terminality is DERIVED
 * from the class rather than carried alongside it, because a carried pair can
 * be minted mismatched (#278 round 6). Returning a bare Error would discard the
 * classification the commerce layer attached and log a precisely classified
 * fault as unknown_error (#278 round 4).
 *
 * Not shared with the JIT version: every branch differs in what it can advise.
 * A JIT failure can suggest buying a pack; a pack failure cannot suggest
 * itself, and suggesting Pay & Send instead is only sound when Pay & Send is
 * configured, which this path has no way to know.
 */
export function friendlyPackCheckoutError(error: unknown): Error {
  const source = (error ?? {}) as { code?: string };
  const diagnosticClass = carriedDiagnosticClass(error);
  const terminal = isTerminalDiagnosticClass(diagnosticClass);
  const friendly = (message: string): Error =>
    Object.assign(new Error(message), {
      ...(source.code !== undefined ? { code: source.code } : {}),
      ...(diagnosticClass !== undefined ? { diagnosticClass } : {})
    });
  switch (source.code) {
    case 'PACK_AMOUNT_NOT_CONFIGURED':
    case 'PRICE_ID_NOT_CONFIGURED':
      return friendly(
        terminal
          ? 'Letter pack pricing is not configured. Please contact support.'
          : 'Letter packs are temporarily unavailable. Please try again shortly.'
      );
    case 'ACCOUNT_SENDS_BLOCKED':
      // A FIXED string. Forwarding the upstream message would carry the
      // internal block label (users.sends_blocked_reason, e.g.
      // "payment_disputed") to the end user (#278 round 12).
      return friendly('Purchasing is disabled on this account. Please contact support.');
    case 'PROVIDER_ERROR':
      return friendly(
        terminal
          ? 'Letter packs cannot be purchased right now. Please contact support.'
          : 'Unable to start the letter pack checkout. Please try again.'
      );
    default:
      return friendly('Unable to start the letter pack checkout. Please try again.');
  }
}

async function handler(
  input: CreatePackCheckoutInput,
  context: ToolContext
): Promise<CreatePackCheckoutOutput> {
  const productId: PackProductId | undefined = PACK_CHOICES[input?.pack];
  if (!productId) {
    throw new Error(
      `create_pack_checkout requires pack to be one of: ${Object.keys(PACK_CHOICES).join(', ')}.`
    );
  }
  const definition = PACK_PRODUCTS.find(product => product.productCode === productId);
  // Unreachable: PACK_CHOICES maps only to codes the catalogue defines, and
  // the type binds the two. Guarded anyway so a future catalogue edit fails
  // loudly here rather than sending an undefined letter count to the customer.
  if (!definition) {
    throw new Error(`create_pack_checkout has no catalogue entry for ${productId}.`);
  }

  try {
    // successUrl/cancelUrl are deliberately omitted: the order id is created
    // inside createPackCheckout, so this tool has nothing to build a return
    // URL from. Omitted, the service derives them from the same helper the
    // Pay & Send path uses.
    // ToolContext.user carries no email, so it is looked up the same way
    // get_account_balance does. Stripe uses it to prefill the receipt address;
    // an empty string is accepted rather than fatal, which is why a missing
    // user does not block the purchase.
    const user = await findUser(context.user.userId);
    const result = await createPackCheckout({
      userId: context.user.userId,
      userEmail: user?.email ?? '',
      productId
    });
    const pending = result.status === 'checkout_pending';
    const displayAmount = formatAmountForCurrency(result.amountCents, result.currency);
    const letterWord = definition.letters === 1 ? 'letter' : 'letters';
    return {
      orderId: result.orderId,
      checkoutUrl: pending ? result.checkoutUrl : undefined,
      letters: definition.letters,
      amountCents: result.amountCents,
      currency: result.currency,
      displayAmount,
      productDescription: result.productDescription,
      expiresAt: result.expiresAt,
      status: result.status,
      reused: result.reused,
      // The message names the link on purpose: the model reads this field
      // more reliably than the schema, and #322 showed it will otherwise say
      // the checkout is "open" or "shown above" when nothing was (#322).
      message: pending
        ? `Checkout created, not opened: show the customer the checkoutUrl as a link to click. Paying ${result.currency.toUpperCase()} ${displayAmount} there adds ${definition.letters} ${letterWord} to this account automatically; nothing is sent until they choose what to mail.`
        : 'This purchase is already paid or being fulfilled. Check its purchase status instead of opening another checkout.'
    };
  } catch (error) {
    throw friendlyPackCheckoutError(error);
  }
}

export const createPackCheckoutTool: McpToolDefinition<
  CreatePackCheckoutInput,
  CreatePackCheckoutOutput
> = {
  name: 'create_pack_checkout',
  description:
    'Create a Stripe-hosted checkout to buy a pack of prepaid letters. The result carries a checkoutUrl that the customer must be shown as a link to click; nothing opens automatically and no card is guaranteed to render, so present the link. The price and pack sizes come only from server configuration. Payment adds letters to the account balance; it does not send anything, so the customer still chooses and sends afterward. Use create_mail_checkout instead to pay for one specific draft.',
  readOnly: false,
  inputSchema: createPackCheckoutInputSchema,
  outputSchema: createPackCheckoutOutputSchema,
  meta: {
    'openai/outputTemplate': OUTPUT_TEMPLATE,
    'openai/toolInvocation/invoking': 'Preparing letter pack checkout...',
    'openai/toolInvocation/invoked': 'Letter pack checkout ready',
    'openai/widgetAccessible': true,
    openWorldHint: true,
    idempotentHint: false
  },
  handler
};
