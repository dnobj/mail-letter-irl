import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { isLetterHomeEnabled } from '../config/letterHome.js';
import { readLetterHome } from '../services/letterHomeService.js';
import { openLetterHomeInputSchema, openLetterHomeOutputSchema } from '../schemas.js';
import { widgetTemplateUri } from '../mcp/widgetUris.js';

async function handler(_input: Record<string, never>, context: ToolContext) {
  if (!isLetterHomeEnabled()) throw new Error('Letter IRL home is not available right now.');
  try {
    return await readLetterHome(context.user.userId);
  } catch {
    context.logger.error({ correlationId: context.correlationId, event: 'home.read_failed' }, 'Unable to load Letter IRL home');
    throw new Error('Unable to load your Letter IRL home right now. Please try again.');
  }
}

export const openLetterHomeTool: McpToolDefinition<Record<string, never>, Awaited<ReturnType<typeof readLetterHome>>> = {
  name: 'open_letter_home',
  title: 'Letter IRL',
  description: 'Open your Letter IRL home: up to 20 active preview drafts and 20 recent letters or postcards, with scheduled dates, delivery status, certified tracking details, and recent recipients. Read-only; does not send or cancel mail. Draft review links open the website where you can review and send.',
  readOnly: true,
  inputSchema: openLetterHomeInputSchema,
  outputSchema: openLetterHomeOutputSchema,
  meta: {
    'openai/ui': { entrypoints: [{ type: 'global' }] },
    'openai/outputTemplate': widgetTemplateUri('LetterHomeCard'),
    'openai/widgetAccessible': true,
    'openai/toolInvocation/invoking': 'Loading your mail...',
    'openai/toolInvocation/invoked': 'Letter IRL home'
  },
  handler
};
