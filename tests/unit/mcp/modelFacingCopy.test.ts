/**
 * What the model reads, and therefore what it repeats to the customer.
 *
 * Two classes of defect have reached production through this surface, neither
 * visible to any existing test:
 *
 * 1. Copy that went stale when something else changed. create_pack_checkout
 *    and list_letter_packs landed in #311/#312, and get_account_balance kept
 *    telling a customer with no letters to "Visit letterirl.com" - leaving the
 *    conversation to do what the card now does, by a route that is also a dead
 *    end while LETTER_IRL_PACKS_URL is unset.
 *
 * 2. Internal units leaking into customer language. Credits are the ledger
 *    unit; letters and image generations are what a customer sees. The
 *    generate_image_for_mail DESCRIPTION said "image credits", which is worse
 *    than a message saying it - a description is permanent model context, read
 *    every turn rather than only when the tool runs (#308).
 *
 * A tool description is the highest-leverage prose in the system and had no
 * coverage whatsoever.
 */

import { describe, expect, it } from 'vitest';
import { LetterIrlServer } from '../../../src/server.js';
import { summarizeToolResult } from '../../../src/mcp/registerTools.js';
import { buildManifest } from '../../../src/mcp/manifest.js';

const tools = new LetterIrlServer().listTools();

describe('tool descriptions and invocation messages', () => {
  it('registers something to check', () => {
    // Guards the two suites below against going vacuously green if listTools
    // ever returns nothing.
    expect(tools.length).toBeGreaterThan(15);
  });

  it.each(tools.map(tool => tool.name))('%s never says "credit"', name => {
    const tool = tools.find(candidate => candidate.name === name)!;
    const meta = (tool.meta ?? {}) as Record<string, unknown>;
    const prose = [
      tool.description,
      meta['openai/toolInvocation/invoking'],
      meta['openai/toolInvocation/invoked']
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');

    expect(prose).not.toMatch(/credit/i);
  });

  it.each(tools.map(tool => tool.name))('%s does not send the customer away to buy', name => {
    // Letters are bought in the conversation now. A description naming the
    // website is read every turn and outlives whatever made it true.
    const tool = tools.find(candidate => candidate.name === name)!;
    expect(tool.description).not.toMatch(/letterirl\.com/i);
  });
});

describe('quote summaries', () => {
  const letterQuote = {
    lettersRequired: 1,
    canSendNow: false,
    reasonCannotSend: 'Not enough letters in your balance.',
    usedSavedReturnAddress: true,
    layoutType: 'text_only'
  };

  it.each([
    'quote_and_preview_letter',
    'quote_and_preview_letter_with_header_image',
    'quote_and_preview_letter_with_image',
    'quote_and_preview_postcard'
  ])('%s states what the tool did, not what the balance is', toolName => {
    // THE DEFECT. The summary used to carry "(cannot send)", which the model
    // rendered as "Your current balance isn't sufficient to send it." True
    // when written; false minutes later once a pack landed - and permanent in
    // the transcript, beside a card by then reading "Ready to send".
    //
    // The model cannot revise a past message and neither can anything else, so
    // the fix is to stop the summary asserting account state that expires.
    const summary = summarizeToolResult(toolName, letterQuote);

    expect(summary).toMatch(/preview ready/i);
    expect(summary).toMatch(/requires 1 letter/i);
    expect(summary).not.toMatch(/cannot send/i);
    expect(summary).not.toMatch(/can send now/i);
    expect(summary).not.toMatch(/balance/i);
  });

  it('reads identically whether or not the draft can be sent', () => {
    // The strongest form of the rule: if the two differ, something in the
    // sentence is a claim about the account rather than about the preview.
    const cannotSend = summarizeToolResult('quote_and_preview_letter', letterQuote);
    const canSend = summarizeToolResult('quote_and_preview_letter', {
      ...letterQuote,
      canSendNow: true,
      reasonCannotSend: undefined
    });

    expect(canSend).toBe(cannotSend);
  });

  it('still carries the details that do not expire', () => {
    const summary = summarizeToolResult('quote_and_preview_letter', {
      ...letterQuote,
      layoutType: 'header_image',
      addressWarnings: ['Street was standardized.']
    });

    expect(summary).toMatch(/header image/i);
    expect(summary).toMatch(/saved return address/i);
    expect(summary).toMatch(/Street was standardized/);
  });
});

describe('the manifest prose ChatGPT reads first', () => {
  // THE GAP THIS CLOSES. The suites above iterate listTools(), so they never
  // saw the two fields ChatGPT reads FIRST: the connector-card `description`
  // and the server `instructions`, which are the model's standing context for
  // every turn. #313 cleaned every tool description and left both behind, and
  // both shipped to production - the description still sending customers to
  // letterirl.com to buy what the card now sells, the instructions still
  // calling image generations "credits". Found by reading the live manifest
  // while connecting the production connector, which is not a test.
  const manifest = buildManifest() as {
    description: string;
    instructions: string;
    [key: string]: unknown;
  };

  it('builds something to check', () => {
    expect(manifest.description.length).toBeGreaterThan(40);
    expect(manifest.instructions.length).toBeGreaterThan(200);
  });

  it.each([
    ['description', () => manifest.description],
    ['instructions', () => manifest.instructions]
  ])('%s does not send the customer away to buy', (_label, get) => {
    // Scoped to the prose. The manifest legitimately carries letterirl.com in
    // contactEmail, legalInfoUrl and the server URLs, so a whole-document
    // check here would fail on the parts that are meant to say it.
    expect(get()).not.toMatch(/letterirl\.com/i);
  });

  it('says "credit" nowhere in the whole document', () => {
    // Credits are the internal ledger unit; customers have letters and image
    // generations. Unlike the URL, there is no legitimate use of the word
    // anywhere in the manifest, so this one sweeps everything - tools,
    // widgets and prose alike - and stays correct as fields are added.
    expect(JSON.stringify(manifest)).not.toMatch(/credit/i);
  });
});
