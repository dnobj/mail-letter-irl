import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { getAddressRequestInputSchema, getAddressRequestOutputSchema } from '../schemas.js';
import {
  getAddressRequest,
  type AddressRequestState,
  type RequestedAddress
} from '../services/addressRequestService.js';
import { AddressRequestRefusedError, addressRequestMessage, requireAddressRequests } from './addressRequestShared.js';

/**
 * What became of an address request (#604): waiting, answered with the
 * address for the preview, declined, cancelled, or expired. Only the
 * account's own requests. Listed only while address requests are on.
 */
export const GET_ADDRESS_REQUEST_TOOL = 'get_address_request';

interface GetAddressRequestInput {
  requestId: string;
}

export interface GetAddressRequestOutput {
  requestId: string;
  status: AddressRequestState;
  recipientName: string;
  expiresAt: string;
  /** The address given, as a preview tool's recipient: only when answered. */
  recipient?: RequestedAddress;
  message: string;
}

/** A request the account does not have, in words the model can act on. */
export function addressRequestNotFound(): AddressRequestRefusedError {
  return new AddressRequestRefusedError(
    'REQUEST_NOT_FOUND',
    "That address request wasn't found on this account. request_address makes a new one."
  );
}

async function handler(input: GetAddressRequestInput, context: ToolContext): Promise<GetAddressRequestOutput> {
  requireAddressRequests();
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  const request = requestId ? await getAddressRequest({ userId: context.user.userId, requestId }) : null;
  if (!request) throw addressRequestNotFound();
  return {
    requestId: request.requestId,
    status: request.state,
    recipientName: request.recipientName,
    expiresAt: request.expiresAt,
    ...(request.address ? { recipient: request.address } : {}),
    message: addressRequestMessage(request)
  };
}

export const getAddressRequestTool: McpToolDefinition<GetAddressRequestInput, GetAddressRequestOutput> = {
  name: GET_ADDRESS_REQUEST_TOOL,
  title: 'Check an address request',
  description:
    'Check an address request made with request_address: whether the recipient has answered. ' +
    'Once answered, it returns their address as recipient, in the shape a letter or postcard preview tool takes, so the preview can be made. ' +
    'It may also say the recipient declined, the request was cancelled, or the link expired before an answer. ' +
    'Call it when the person says the recipient has answered, or asks; it sends nothing.',
  readOnly: true,
  inputSchema: getAddressRequestInputSchema,
  outputSchema: getAddressRequestOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Checking the address request...',
    'openai/toolInvocation/invoked': 'Address request checked',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  },
  handler
};
