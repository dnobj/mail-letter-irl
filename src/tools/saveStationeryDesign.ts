import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { designNameOf, designOf } from '../render/stationery.js';
import { MAX_STATIONERY_DESIGNS, saveDesign } from '../services/stationeryDesignService.js';
import { DesignRefusedError, designOutput, requireDesigns, type DesignOutput } from './stationeryDesignShared.js';

/**
 * Saves a stationery design the person made with the chat (#649): a name and
 * four choices, each made of what the built-in themes already draw. Saving
 * under a name the account has replaces that design; letters already
 * previewed keep their own copy. Listed only while designs are offered
 * (src/server.ts).
 */
export const SAVE_STATIONERY_DESIGN_TOOL = 'save_stationery_design';

interface SaveStationeryDesignInput {
  name: string;
  face: string;
  ornament: string;
  ruled: boolean;
  tone: string;
}

export interface SaveStationeryDesignOutput extends DesignOutput {
  /** Whether a design of the same name was replaced. */
  replaced: boolean;
  message: string;
}

async function handler(input: SaveStationeryDesignInput, context: ToolContext): Promise<SaveStationeryDesignOutput> {
  requireDesigns();
  const name = designNameOf(input.name);
  if (name === null) {
    throw new DesignRefusedError(
      'DESIGN_NAME_INVALID',
      'Give the design a name of 1 to 40 characters, such as "Garden letters", that the person will recognise.'
    );
  }
  const design = designOf({ face: input.face, ornament: input.ornament, ruled: input.ruled, tone: input.tone });
  if (!design) {
    throw new DesignRefusedError(
      'DESIGN_CHOICE_INVALID',
      'Choose each of face (serif, typewriter or handwritten), ornament (none, monogram, sprig or confetti), ruled (true or false) and tone (black, dark, medium or light).'
    );
  }
  // A personal access token adds designs and never replaces one (#685).
  const token = context.client?.name === 'token';
  const result = await saveDesign(context.user.userId, name, design, { replace: !token });
  if (!result.ok && result.refusal === 'exists') {
    throw new DesignRefusedError(
      'DESIGN_NAME_TAKEN',
      'A personal access token can save a new design but not replace one: save it under another name, or replace it on the Letter IRL website or in an app signed in with your Letter IRL account.'
    );
  }
  if (!result.ok && result.refusal === 'limit') {
    throw new DesignRefusedError(
      'DESIGN_LIMIT',
      token
        ? `This account has ${MAX_STATIONERY_DESIGNS} saved designs, the most it may keep. A personal access token can't delete or replace one: the person can, on the Letter IRL website or in an app signed in with their Letter IRL account.`
        : `This account has ${MAX_STATIONERY_DESIGNS} saved designs, the most it may keep. Delete one the person no longer wants (delete_stationery_design), or save under the name of one to replace it.`
    );
  }
  if (!result.ok) throw new DesignRefusedError('ACCOUNT_CLOSED', 'This account is closed, so nothing can be saved to it.');
  context.logger.info(
    { correlationId: context.correlationId, event: 'stationery_design.saved', replaced: result.replaced, ...design },
    'A stationery design was saved'
  );
  return {
    ...designOutput(result.saved),
    replaced: result.replaced,
    message:
      (result.replaced ? 'Replaced the saved design of that name. ' : 'Saved the design. ') +
      'Draw a letter in it with stationeryDesignId on a letter preview or set_stationery; letters already previewed keep their own. ' +
      'It prints in black and greys, as every letter does.'
  };
}

export const saveStationeryDesignTool: McpToolDefinition<SaveStationeryDesignInput, SaveStationeryDesignOutput> = {
  name: SAVE_STATIONERY_DESIGN_TOOL,
  title: 'Save a stationery design',
  description: (client) =>
    'Save a stationery design the person describes for their letters: a name, a face, a corner ornament, ruled lines or not, and a grey tone. ' +
    'Only when the person wants a design of their own kept; for one letter, the built-in stationery may do. ' +
    // A personal access token adds designs and replaces none (#685).
    (client.name === 'token'
      ? 'A design is saved only under a name the account does not have yet, so check list_stationery_designs first. '
      : 'Saving under a name the account has replaces that design, so check list_stationery_designs first. ') +
    `An account keeps at most ${MAX_STATIONERY_DESIGNS}. ` +
    'A letter is drawn in a saved design with its designId as stationeryDesignId on a letter preview or set_stationery.',
  readOnly: false,
  meta: {
    'openai/toolInvocation/invoking': 'Saving the design...',
    'openai/toolInvocation/invoked': 'Design saved',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true
  },
  handler
};
