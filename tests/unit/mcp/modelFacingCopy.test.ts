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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LetterIrlServer } from '../../../src/server.js';
import { summarizeToolResult } from '../../../src/mcp/registerTools.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { buildServerInstructions } from '../../../src/mcp/serverInstructions.js';
import { CLIENT_PROFILE_NAMES, clientProfileNamed } from '../../../src/auth/clientProfiles.js';

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

  it('create_pack_checkout tells the model to present the checkout link (issue #322)', () => {
    // The model has described this checkout as "open" or "shown above" with
    // no link in front of the customer. The description is permanent model
    // context, so the instruction to present the URL lives here, and the
    // card carries the anchor for the times the model still does not.
    const tool = tools.find(candidate => candidate.name === 'create_pack_checkout')!;
    expect(tool.description).toMatch(/checkoutUrl/);
    expect(tool.description).toMatch(/shown as a link/i);
    expect(tool.description).toMatch(/nothing opens automatically/i);
    expect(tool.meta?.['openai/outputTemplate']).toMatch(/PackCheckoutCard/);
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
    // An email address is not a website: refund requests go to
    // support@letterirl.com by design (#323), so a mailbox at the domain is
    // allowed here and a URL or bare domain still is not.
    expect(get()).not.toMatch(/(?<!@)letterirl\.com/i);
  });

  it('says "credit" nowhere in the whole document', () => {
    // Credits are the internal ledger unit; customers have letters and image
    // generations. Unlike the URL, there is no legitimate use of the word
    // anywhere in the manifest, so this one sweeps everything - tools,
    // widgets and prose alike - and stays correct as fields are added.
    expect(JSON.stringify(manifest)).not.toMatch(/credit/i);
  });
});

/**
 * Every app's own words (#484). Claude on development showed tool
 * descriptions where the tool names belong, read "so ChatGPT can reuse that
 * existing image" in three preview tools, and offered to set up a pack purchase
 * because a description said letters could be bought without leaving the
 * conversation - where Claude allows no purchases through connectors (#475).
 */
describe('tool text in every app', () => {
  afterEach(() => vi.unstubAllEnvs());

  // With the send rule on, so request_send is in the list too.
  const listed = (name: (typeof CLIENT_PROFILE_NAMES)[number]) => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    return new LetterIrlServer().listTools(clientProfileNamed(name));
  };

  it('walks every app', () => {
    expect(CLIENT_PROFILE_NAMES).toEqual(
      expect.arrayContaining(['chatgpt', 'claude', 'claude_code', 'codex', 'vscode', 'hermes', 'token', 'generic'])
    );
  });

  it('gives every tool a short title of its own', () => {
    const all = listed('generic');
    expect(all.map(tool => tool.name)).toContain('request_send');
    for (const tool of all) {
      expect(typeof tool.title, tool.name).toBe('string');
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      // Short enough to stand where a name stands: a title is not a sentence.
      expect(tool.title.length, `${tool.name}: "${tool.title}"`).toBeLessThanOrEqual(40);
      expect(tool.title.endsWith('.'), tool.name).toBe(false);
      expect(tool.title.charAt(0), tool.name).toBe(tool.title.charAt(0).toUpperCase());
      expect(tool.title, tool.name).not.toMatch(/ChatGPT|credit/i);
      expect(tool.description.startsWith(tool.title), tool.name).toBe(false);
    }
    expect(new Set(all.map(tool => tool.title)).size).toBe(all.length);
  });

  it.each(CLIENT_PROFILE_NAMES.map(name => [name]))('%s: no description says "credit"', name => {
    for (const tool of listed(name)) {
      expect(tool.description, tool.name).not.toMatch(/credit/i);
    }
  });

  it.each(CLIENT_PROFILE_NAMES.filter(name => name !== 'chatgpt').map(name => [name]))(
    '%s: no description or instruction names ChatGPT',
    name => {
      for (const tool of listed(name)) {
        expect(tool.description, tool.name).not.toMatch(/ChatGPT|image_gen/);
      }
      for (const sendRule of [false, true]) {
        expect(buildServerInstructions(sendRule, clientProfileNamed(name))).not.toMatch(/ChatGPT|image_gen/);
      }
    }
  );

  it.each(CLIENT_PROFILE_NAMES.filter(name => !clientProfileNamed(name).inAppPurchases).map(name => [name]))(
    '%s: no description promises a purchase in the conversation',
    name => {
      for (const tool of listed(name)) {
        expect(tool.description, tool.name).not.toMatch(
          /without leaving the conversation|right here|buy a letter pack here|create_pack_checkout buys/i
        );
      }
    }
  );

  it.each(CLIENT_PROFILE_NAMES.filter(name => !clientProfileNamed(name).rendersCards).map(name => [name]))(
    '%s: the instructions name no card button',
    name => {
      for (const sendRule of [false, true]) {
        expect(buildServerInstructions(sendRule, clientProfileNamed(name))).not.toContain('Create my preview');
      }
    }
  );

  it("keeps ChatGPT's text and forks only the three lines that differ", () => {
    // ChatGPT's instructions are pinned verbatim in sendRule.test.ts. The
    // no-result line (a card button), the image line (ChatGPT's own
    // generation) and the upload line (ChatGPT's library) are the only ones
    // another app reads differently; everything else is one text for all.
    for (const sendRule of [false, true]) {
      const chatgpt = buildServerInstructions(sendRule, clientProfileNamed('chatgpt')).split('\n');
      const other = buildServerInstructions(sendRule, clientProfileNamed('generic')).split('\n');
      expect(other).toHaveLength(chatgpt.length);
      const forked = other.filter((line, index) => line !== chatgpt[index]);
      expect(forked).toHaveLength(3);
      expect(forked.join(' ')).toContain('generate_image_for_mail');
      expect(forked.join(' ')).toContain('upload_image');
      expect(forked.join(' ')).toContain('returns no result');
    }
  });
});
