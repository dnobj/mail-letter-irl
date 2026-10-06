import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { deleteStationeryDesignInputSchema, deleteStationeryDesignOutputSchema } from '../schemas.js';
import { deleteDesign } from '../services/stationeryDesignService.js';
import { DesignRefusedError, requireDesigns } from './stationeryDesignShared.js';

/**
 * Deletes one of the person's saved stationery designs (#649). Letters already
 * previewed or sent keep their own copy; the account forgets it if it
 * remembered it. Listed only while designs are offered (src/server.ts).
 */
export const DELETE_STATIONERY_DESIGN_TOOL = 'delete_stationery_design';

interface DeleteStationeryDesignInput {
  designId: string;
  confirm: boolean;
}

export interface DeleteStationeryDesignOutput {
  /** Whether a design was deleted: false when the account has none with that id. */
  deleted: boolean;
  message: string;
}

async function handler(input: DeleteStationeryDesignInput, context: ToolContext): Promise<DeleteStationeryDesignOutput> {
  requireDesigns();
  if (input.confirm !== true) {
    throw new DesignRefusedError(
      'CONFIRM_REQUIRED',
      'Ask the person to confirm, then call again with confirm: true. A deleted design cannot be brought back; save_stationery_design saves one again.'
    );
  }
  const designId = typeof input.designId === 'string' ? input.designId.trim() : '';
  const deleted = await deleteDesign(context.user.userId, designId);
  context.logger.info({ correlationId: context.correlationId, event: 'stationery_design.deleted', deleted }, 'A stationery design was deleted');
  return {
    deleted,
    message: deleted
      ? 'Deleted the design. Letters already previewed or sent keep theirs.'
      : "The account has no design with that designId, so nothing changed. list_stationery_designs lists the account's designs."
  };
}

export const deleteStationeryDesignTool: McpToolDefinition<DeleteStationeryDesignInput, DeleteStationeryDesignOutput> = {
  name: DELETE_STATIONERY_DESIGN_TOOL,
  title: 'Delete a saved stationery design',
  description:
    "Delete one of the person's saved stationery designs, by its designId. Letters already previewed or sent keep theirs. " +
    'Requires confirm: true, once the person has agreed. It cannot be undone; save_stationery_design saves one again.',
  readOnly: false,
  inputSchema: deleteStationeryDesignInputSchema,
  outputSchema: deleteStationeryDesignOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Deleting the design...',
    'openai/toolInvocation/invoked': 'Design deleted',
    destructiveHint: true
  },
  handler
};
