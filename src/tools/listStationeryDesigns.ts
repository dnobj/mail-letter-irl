import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { listStationeryDesignsInputSchema, listStationeryDesignsOutputSchema } from '../schemas.js';
import { listDesigns, MAX_STATIONERY_DESIGNS, rememberedDesign } from '../services/stationeryDesignService.js';
import { designOutput, requireDesigns, type DesignOutput } from './stationeryDesignShared.js';

/**
 * The person's saved stationery designs (#649), oldest first, and the one the
 * account remembers for its next preview. Read-only. Listed only while designs
 * are offered (src/server.ts).
 */
export const LIST_STATIONERY_DESIGNS_TOOL = 'list_stationery_designs';

type ListStationeryDesignsInput = Record<string, never>;

export interface ListStationeryDesignsOutput {
  designs: DesignOutput[];
  /** The design a letter preview that names no stationery is drawn in, when the account remembers one. */
  rememberedDesignId?: string;
  /** The most designs an account may keep. */
  limit: number;
  message: string;
}

async function handler(_input: ListStationeryDesignsInput, context: ToolContext): Promise<ListStationeryDesignsOutput> {
  requireDesigns();
  const [designs, remembered] = await Promise.all([listDesigns(context.user.userId), rememberedDesign(context.user.userId)]);
  return {
    designs: designs.map(designOutput),
    ...(remembered ? { rememberedDesignId: remembered.designId } : {}),
    limit: MAX_STATIONERY_DESIGNS,
    message:
      designs.length === 0
        ? 'No stationery designs are saved. save_stationery_design saves one the person describes.'
        : `${designs.length} saved stationery design${designs.length === 1 ? '' : 's'}. Draw a letter in one with its designId as stationeryDesignId.`
  };
}

export const listStationeryDesignsTool: McpToolDefinition<ListStationeryDesignsInput, ListStationeryDesignsOutput> = {
  name: LIST_STATIONERY_DESIGNS_TOOL,
  title: 'List saved stationery designs',
  description:
    "List the person's saved stationery designs, with each one's designId, name and choices, and the one their next letter preview " +
    'is drawn in when it names no stationery. Read-only: it changes and sends nothing.',
  readOnly: true,
  inputSchema: listStationeryDesignsInputSchema,
  outputSchema: listStationeryDesignsOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Checking the designs...',
    'openai/toolInvocation/invoked': 'Designs checked'
  },
  handler
};
