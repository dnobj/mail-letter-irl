import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { addressRequestDailyCap, addressRequestLinkDays } from '../config/addressRequests.js';
import { requestAddressInputSchema, requestAddressOutputSchema } from '../schemas.js';
import { createAddressRequest } from '../services/addressRequestService.js';
import { getReturnAddress } from '../services/returnAddressService.js';
import { AccountErasedError } from '../auth/accountErased.js';
import {
  AddressRequestRefusedError,
  addressRequestUrl,
  firstNameFromSaved,
  linkExpiry,
  recipientNameOf,
  requireAddressRequests,
  senderFirstNameOf
} from './addressRequestShared.js';

/**
 * Makes an address request (#604, concept 10): a private link the person
 * shares, themselves, with someone whose address they lack. The page it opens
 * shows only the sender's first name, and takes a U.S. address or a decline.
 * Letter IRL never contacts the recipient.
 *
 * The letter waits in the conversation, not as a draft: a draft lasts a day
 * and needs its address. get_address_request returns the address once it is
 * given, for the preview. Listed only while LETTER_IRL_ADDRESS_REQUESTS_ENABLED
 * is on (src/server.ts).
 */
export const REQUEST_ADDRESS_TOOL = 'request_address';

interface RequestAddressInput {
  recipientName: string;
  senderFirstName?: string;
}

export interface RequestAddressOutput {
  requestId: string;
  status: 'waiting';
  /** The link, given only here: the server keeps its token's hash. */
  url: string;
  recipientName: string;
  senderFirstName: string;
  expiresAt: string;
  message: string;
}

async function handler(input: RequestAddressInput, context: ToolContext): Promise<RequestAddressOutput> {
  requireAddressRequests();
  const recipientName = recipientNameOf(input.recipientName);
  const senderFirstName =
    senderFirstNameOf(input.senderFirstName) ??
    firstNameFromSaved((await getReturnAddress(context.user.userId))?.name);
  if (!senderFirstName) {
    throw new AddressRequestRefusedError(
      'SENDER_NAME_REQUIRED',
      'Ask the person which first name the page should show, and pass it as senderFirstName: the page shows only that of them.'
    );
  }

  const created = await createAddressRequest({ userId: context.user.userId, recipientName, senderFirstName });
  if (!created.ok) {
    // Erased while this waited for the account's lock.
    if (created.refusal === 'account_closed') throw new AccountErasedError();
    throw created.refusal === 'waiting_cap'
      ? new AddressRequestRefusedError(
          'TOO_MANY_WAITING',
          `This account has ${created.cap} address requests waiting for an answer. cancel_address_request closes one that is no longer needed.`
        )
      : new AddressRequestRefusedError(
          'TOO_MANY_TODAY',
          `This account has made ${created.cap} address requests in the last day. Try again tomorrow.`
        );
  }

  const { request, token } = created;
  const url = addressRequestUrl(token);
  // The request's id only: never the link, the names or an address.
  context.logger.info(
    { correlationId: context.correlationId, event: 'address_request.created', requestId: request.requestId },
    'Address request made'
  );
  return {
    requestId: request.requestId,
    status: 'waiting',
    url,
    recipientName,
    senderFirstName,
    expiresAt: request.expiresAt,
    message:
      `Here is the link that asks ${recipientName} for their address: ${url} ` +
      `Letter IRL doesn't send it: share it with ${recipientName} yourself, by text or email. ` +
      `It works once, until ${linkExpiry(request.expiresAt)}, and the page shows only the first name ${senderFirstName}. ` +
      `Once ${recipientName} answers, the mail can be previewed with their address.`
  };
}

function describe(): string {
  const days = addressRequestLinkDays();
  const daily = addressRequestDailyCap();
  return (
    "Use this when the person wants to send mail to someone whose U.S. mailing address they don't know. " +
    'It makes a private link for the person to share with that recipient themselves: Letter IRL never contacts them. ' +
    'The page the link opens shows only the sender\'s first name, and the recipient types their address there or declines. ' +
    `The link works once and for ${days} days. It is free and sends nothing. ` +
    `Each call makes a new link, and an account may make ${daily} a day, so make one per recipient. ` +
    'Keep the letter\'s words in the conversation. When the person says the recipient has answered, call get_address_request with the requestId: ' +
    'once answered, it returns the address as recipient, ready for a preview tool. ' +
    'Do not use it for an address the person already has, or to look an address up.'
  );
}

export const requestAddressTool: McpToolDefinition<RequestAddressInput, RequestAddressOutput> = {
  name: REQUEST_ADDRESS_TOOL,
  title: 'Request an address',
  description: describe,
  readOnly: false,
  inputSchema: requestAddressInputSchema,
  outputSchema: requestAddressOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Making the address request...',
    'openai/toolInvocation/invoked': 'Address request ready',
    // It records a request and nothing else: no mail, no message to anyone.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false
  },
  handler
};
