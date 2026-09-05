import {
  PACK_CHOICES,
  PACK_PRODUCTS,
  formatAmountForCurrency,
  type PackChoice
} from '../config/products.js';
import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { listLetterPacksInputSchema, listLetterPacksOutputSchema } from '../schemas.js';
import { ensurePriceCatalog } from '../services/priceCatalog.js';
import { getPackProductConfig } from '../services/stripeService.js';

interface ListLetterPacksInput {
  [key: string]: never;
}

interface LetterPackOption {
  pack: PackChoice;
  letters: number;
  amountCents: number;
  currency: string;
  displayAmount: string;
  description: string;
}

interface ListLetterPacksOutput {
  packs: LetterPackOption[];
  message: string;
}

async function handler(
  _input: ListLetterPacksInput,
  _context: ToolContext
): Promise<ListLetterPacksOutput> {
  // Prices resolve lazily (#275 stage A). They are already warmed at boot by
  // kickPriceCatalog(undefined, "http_listen"), so this is normally a memo read
  // rather than a network call - but awaiting it is what makes the tool correct
  // in a process that has not warmed yet, and every other entrypoint that can
  // reach a product config does the same.
  await ensurePriceCatalog();

  const packs: LetterPackOption[] = [];
  for (const [pack, productCode] of Object.entries(PACK_CHOICES) as [
    PackChoice,
    (typeof PACK_CHOICES)[PackChoice]
  ][]) {
    const definition = PACK_PRODUCTS.find(product => product.productCode === productCode);
    const config = getPackProductConfig(productCode);
    // An unresolved price yields amountCents 0, and createPackCheckout refuses
    // exactly that with PackAmountNotConfiguredError. Listing such a pack would
    // be offering a button guaranteed to fail on click, so it is omitted rather
    // than shown as unavailable - there is nothing the customer can do about it.
    if (!definition || !config || !Number.isInteger(config.amountCents) || config.amountCents <= 0) {
      continue;
    }
    packs.push({
      pack,
      // From the catalogue, not credits/2: the division is only correct while
      // pricing is flat, which tests/unit/tools/letterBalanceEquivalence.test.ts
      // pins (#308).
      letters: definition.letters,
      amountCents: config.amountCents,
      currency: config.currency,
      // Server-formatted per currency. A widget dividing minor units by 100 is
      // 100x wrong for the zero-decimal currencies this codebase declares
      // support for (#278 round 6).
      displayAmount: formatAmountForCurrency(config.amountCents, config.currency),
      description: definition.description
    });
  }

  return {
    packs,
    // An empty list is a real answer, not a fault to throw over: every pack
    // being unpriced is a configuration problem the customer cannot act on, and
    // a refusal here would read to the model as a broken tool rather than an
    // unavailable product.
    message: packs.length
      ? `${packs.length} letter ${packs.length === 1 ? 'pack is' : 'packs are'} available to buy.`
      : 'Letter packs are temporarily unavailable.'
  };
}

export const listLetterPacksTool: McpToolDefinition<ListLetterPacksInput, ListLetterPacksOutput> = {
  name: 'list_letter_packs',
  description:
    'List the letter packs available to buy, with how many letters each adds and what it costs. Use this to answer questions about pack sizes or pricing, and before create_pack_checkout when the customer has not said which size they want.',
  readOnly: true,
  inputSchema: listLetterPacksInputSchema,
  outputSchema: listLetterPacksOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Checking letter packs...',
    'openai/toolInvocation/invoked': 'Letter packs listed',
    // The preview cards call this when Buy a Letter Pack is clicked, so the
    // sizes and prices can be shown before anything is bought.
    'openai/widgetAccessible': true,
    // No idempotentHint: this repository treats it as meaningless alongside
    // readOnlyHint, and a consistency test enforces that a read-only tool
    // carries one or the other, not both.
    readOnlyHint: true
  },
  handler
};
