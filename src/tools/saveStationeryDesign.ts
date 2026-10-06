import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { designNameOf, designOf } from '../render/stationery.js';
import { saveStationeryDesignInputSchema, saveStationeryDesignOutputSchema } from '../schemas.js';
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
  const result = await saveDesign(context.user.userId, name, design);
  if (!result.ok && result.refusal === 'limit') {
    throw new DesignRefusedError(
      'DESIGN_LIMIT',
      `This account has ${MAX_STATIONERY_DESIGNS} saved designs, the most it may keep. Delete one the person no longer wants (delete_stationery_design), or save under the name of one to replace it.`
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
  description:
    'Save a stationery design the person describes, for their letters: a name and four choices. ' +
    'face: serif (a classic book face), typewriter (a monospace face, fewer words to the page) or handwritten (a handwriting face, no Greek, Hebrew or Vietnamese). ' +
    'ornament, in the top-right corner beside the address window: none, monogram (initials in a double ring), sprig (a line-drawn sprig with berries) or confetti. ' +
    'ruled: faint rules under each line. tone: the ornament\'s grey, black, dark, medium or light; letters print in black and greys only. ' +
    `Saving under a name the account has replaces that design; an account keeps at most ${MAX_STATIONERY_DESIGNS}. ` +
    'Then draw a letter in it with stationeryDesignId on a letter preview or set_stationery. Nothing is previewed or sent by this tool.',
  readOnly: false,
  inputSchema: saveStationeryDesignInputSchema,
  outputSchema: saveStationeryDesignOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Saving the design...',
    'openai/toolInvocation/invoked': 'Design saved',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true
  },
  handler
};
