import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { cancelAddressRequestInputSchema, cancelAddressRequestOutputSchema } from '../schemas.js';
import { cancelAddressRequest, type AddressRequestState } from '../services/addressRequestService.js';
import { addressRequestMessage, requireAddressRequests } from './addressRequestShared.js';
import { addressRequestNotFound } from './getAddressRequest.js';

/**
 * Closes a waiting address request (#604): its link stops working. One
 * already answered, declined, cancelled or expired is left as it is. Listed
 * only while address requests are on.
 */
export const CANCEL_ADDRESS_REQUEST_TOOL = 'cancel_address_request';

interface CancelAddressRequestInput {
  requestId: string;
}

export interface CancelAddressRequestOutput {
  requestId: string;
  status: AddressRequestState;
  /** True when it was no longer waiting: nothing changed. */
  alreadyClosed: boolean;
  message: string;
}

async function handler(input: CancelAddressRequestInput, context: ToolContext): Promise<CancelAddressRequestOutput> {
  requireAddressRequests();
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  const result = requestId
    ? await cancelAddressRequest({ userId: context.user.userId, requestId })
    : ({ ok: false, refusal: 'not_found' } as const);
  if (!result.ok) throw addressRequestNotFound();
  const { request, alreadyClosed } = result;
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: 'address_request.cancel_tool',
      requestId: request.requestId,
      alreadyClosed
    },
    'Address request cancelled'
  );
  return {
    requestId: request.requestId,
    status: request.state,
    alreadyClosed,
    message: alreadyClosed
      ? `Nothing changed. ${addressRequestMessage(request)}`
      : `Cancelled: the link for ${request.recipientName} no longer works.`
  };
}

export const cancelAddressRequestTool: McpToolDefinition<CancelAddressRequestInput, CancelAddressRequestOutput> = {
  name: CANCEL_ADDRESS_REQUEST_TOOL,
  title: 'Cancel an address request',
  description:
    "Cancel an address request made with request_address that is still waiting, so its link stops working: for example when the person " +
    "has the address another way, or shared the link by mistake. A request already answered, declined or expired is left as it is, and the answer says so. " +
    'It cannot be undone; a new request makes a new link.',
  readOnly: false,
  inputSchema: cancelAddressRequestInputSchema,
  outputSchema: cancelAddressRequestOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Cancelling the address request...',
    'openai/toolInvocation/invoked': 'Address request cancelled',
    // Its link cannot be restored, and a repeat answers as already closed.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true
  },
  handler
};
