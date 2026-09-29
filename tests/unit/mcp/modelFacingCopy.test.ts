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

// ChatGPT's list is the full one: an app that takes no purchases is not
// offered the checkouts (#475). The other apps' text has its own suite below.
const tools = new LetterIrlServer().listTools(clientProfileNamed('chatgpt'));

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

  it("keeps ChatGPT's text and forks only the four lines that differ", () => {
    // ChatGPT's instructions are pinned verbatim in sendRule.test.ts. Another
    // app reads its own version of four lines, and everything else is one text
    // for all:
    // - the same-mail line, which names create_mail_checkout (#475);
    // - the no-result line (a card button, and a checkout);
    // - the image line (ChatGPT's own generation);
    // - the upload line (ChatGPT's library).
    for (const sendRule of [false, true]) {
      const chatgpt = buildServerInstructions(sendRule, clientProfileNamed('chatgpt')).split('\n');
      const other = buildServerInstructions(sendRule, clientProfileNamed('generic')).split('\n');
      expect(other).toHaveLength(chatgpt.length);
      const forked = other.filter((line, index) => line !== chatgpt[index]);
      expect(forked).toHaveLength(4);
      expect(forked.join(' ')).toContain('another copy');
      expect(forked.join(' ')).toContain('generate_image_for_mail');
      expect(forked.join(' ')).toContain('upload_image');
      expect(forked.join(' ')).toContain('returns no result');
    }
  });
});

/**
 * Purchases per app (#475). Claude allows no purchases through connectors, and
 * the Connectors Directory takes no connector that executes financial
 * transactions. In CLIENT-01 step 7, Claude still offered "a checkout link for
 * a starter, regular, or power pack" because create_pack_checkout was in its
 * tool list.
 */
describe('purchases in every app', () => {
  afterEach(() => vi.unstubAllEnvs());

  const CHECKOUTS = ['create_pack_checkout', 'create_mail_checkout'];
  const noPurchases = CLIENT_PROFILE_NAMES.filter(name => !clientProfileNamed(name).inAppPurchases);

  it('offers the checkouts only where the app takes purchases', () => {
    expect(noPurchases.length).toBeGreaterThan(0);
    for (const sendRule of ['false', 'true']) {
      vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', sendRule);
      const chatgpt = new LetterIrlServer().listTools(clientProfileNamed('chatgpt')).map(tool => tool.name);
      expect(chatgpt).toEqual(expect.arrayContaining(CHECKOUTS));
      for (const name of noPurchases) {
        const listed = new LetterIrlServer().listTools(clientProfileNamed(name)).map(tool => tool.name);
        for (const checkout of CHECKOUTS) {
          expect(listed, `${name} lists ${checkout}`).not.toContain(checkout);
        }
        // Everything else is the same list, less image generation where it is
        // off (the suite below).
        const imagesOff = clientProfileNamed(name).offersImageGeneration ? 0 : 1;
        expect(listed.length, name).toBe(chatgpt.length - CHECKOUTS.length - imagesOff);
      }
    }
  });

  it.each(noPurchases.map(name => [name]))('%s: nothing points at a checkout it is not offered', name => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    for (const tool of new LetterIrlServer().listTools(clientProfileNamed(name))) {
      expect(tool.description, tool.name).not.toMatch(/create_pack_checkout|create_mail_checkout|checkout/i);
    }
    for (const sendRule of [false, true]) {
      expect(buildServerInstructions(sendRule, clientProfileNamed(name))).not.toMatch(/checkout/i);
    }
  });
});

/**
 * Letter IRL's AI image generation, per app (#467). Anthropic's Connectors
 * Directory does not accept a connector that generates images through AI
 * models, and the owner turned it off in Claude on 2026-09-26: Claude and
 * Claude Code are not offered generate_image_for_mail, and nothing they read
 * points at it.
 */
describe('image generation in every app', () => {
  afterEach(() => vi.unstubAllEnvs());

  const noImages = CLIENT_PROFILE_NAMES.filter(name => !clientProfileNamed(name).offersImageGeneration);

  it('is off in Claude and Claude Code, and on everywhere else', () => {
    expect([...noImages].sort()).toEqual(['claude', 'claude_code']);
    for (const name of CLIENT_PROFILE_NAMES) {
      const listed = new LetterIrlServer().listTools(clientProfileNamed(name)).map(tool => tool.name);
      expect(listed.includes('generate_image_for_mail'), name).toBe(!noImages.includes(name));
    }
  });

  it.each(noImages.map(name => [name]))('%s: nothing points at image generation', name => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    for (const tool of new LetterIrlServer().listTools(clientProfileNamed(name))) {
      expect(tool.description, tool.name).not.toContain('generate_image_for_mail');
    }
    for (const sendRule of [false, true]) {
      const instructions = buildServerInstructions(sendRule, clientProfileNamed(name));
      expect(instructions).not.toContain('generate_image_for_mail');
      expect(instructions).toContain('Letter IRL does not make images in this app.');
    }
  });
});

/**
 * The image switch (src/config/imageGeneration.ts). With LETTER_IRL_IMAGE_GEN_MODE
 * set to off, no app is offered generate_image_for_mail, so no agent thinks it
 * can call it. ChatGPT is told to use its own image generation, and every
 * other app that Letter IRL makes no images.
 */
describe('image generation switched off', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('leaves the tool out of every app\'s list, and "redirect" keeps it', () => {
    vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
    for (const name of CLIENT_PROFILE_NAMES) {
      const listed = new LetterIrlServer().listTools(clientProfileNamed(name)).map(tool => tool.name);
      expect(listed, name).not.toContain('generate_image_for_mail');
    }
    vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'redirect');
    expect(
      new LetterIrlServer().listTools(clientProfileNamed('chatgpt')).map(tool => tool.name)
    ).toContain('generate_image_for_mail');
  });

  it('sends ChatGPT to its own image generation, and tells every other app Letter IRL makes none', () => {
    vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
    for (const sendRule of [false, true]) {
      const chatgpt = buildServerInstructions(sendRule, clientProfileNamed('chatgpt'));
      expect(chatgpt).not.toContain('generate_image_for_mail');
      expect(chatgpt).toContain(
        "Letter IRL does not make images. For an image, use ChatGPT's built-in image generation (image_gen)"
      );
      expect(chatgpt).toContain('a message that does not mention Letter IRL');
      for (const name of CLIENT_PROFILE_NAMES.filter(entry => entry !== 'chatgpt')) {
        const instructions = buildServerInstructions(sendRule, clientProfileNamed(name));
        expect(instructions, name).not.toContain('generate_image_for_mail');
        expect(instructions, name).toContain('Letter IRL does not make images in this app.');
        expect(instructions, name).not.toMatch(/ChatGPT|image_gen/);
      }
    }
  });
});

/**
 * How a preview is sent, per app (#516). Under the send rule no model sends
 * mail: Claude Code's model sees neither send_letter nor send_postcard, and
 * ChatGPT keeps them for the card alone. The preview tools' descriptions still ended
 * "Send later with send_letter", which pointed the model at a tool it may not
 * call. Claude Code's model reads the descriptions but never the preview's own
 * text, so the description is where it learns how the person sends.
 */
describe('how a preview is sent, in every app', () => {
  afterEach(() => vi.unstubAllEnvs());

  const PREVIEWS = [
    'quote_and_preview_letter',
    'quote_and_preview_letter_with_header_image',
    'quote_and_preview_letter_with_image',
    'quote_and_preview_postcard'
  ];
  const previewsFor = (name: (typeof CLIENT_PROFILE_NAMES)[number]) =>
    new LetterIrlServer().listTools(clientProfileNamed(name)).filter(tool => PREVIEWS.includes(tool.name));
  const withCards = CLIENT_PROFILE_NAMES.filter(name => clientProfileNamed(name).rendersCards);
  const withoutCards = CLIENT_PROFILE_NAMES.filter(name => !clientProfileNamed(name).rendersCards);

  it('covers both kinds of app and all four previews', () => {
    expect(withCards).toEqual(expect.arrayContaining(['chatgpt', 'claude']));
    expect(withoutCards).toContain('claude_code');
    for (const sendRule of ['false', 'true']) {
      vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', sendRule);
      for (const name of CLIENT_PROFILE_NAMES) {
        expect(previewsFor(name).map(tool => tool.name).sort(), name).toEqual([...PREVIEWS].sort());
      }
    }
  });

  it('names no send tool under the send rule, in any app', () => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    for (const name of CLIENT_PROFILE_NAMES) {
      for (const tool of previewsFor(name)) {
        expect(tool.description, `${name} ${tool.name}`).not.toMatch(/send_letter|send_postcard|Send later/);
        expect(tool.description, `${name} ${tool.name}`).toMatch(/Nothing is sent from here: .*request_send/);
      }
    }
  });

  it("points to the card's Send where the app shows our card, and to the link elsewhere", () => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    for (const name of withCards) {
      for (const tool of previewsFor(name)) {
        expect(tool.description, `${name} ${tool.name}`).toMatch(
          /the person sends it with Send on the preview card, or, if no card shows, on the page request_send links to\.$/
        );
      }
    }
    for (const name of withoutCards) {
      for (const tool of previewsFor(name)) {
        expect(tool.description, `${name} ${tool.name}`).not.toContain('preview card');
        expect(tool.description, `${name} ${tool.name}`).toMatch(
          /to send it, call request_send and give the person its link\.$/
        );
      }
    }
  });

  it('keeps naming the send tool while the rule is off', () => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'false');
    for (const name of CLIENT_PROFILE_NAMES) {
      for (const tool of previewsFor(name)) {
        const sendTool = tool.name === 'quote_and_preview_postcard' ? 'send_postcard' : 'send_letter';
        expect(tool.description, `${name} ${tool.name}`).toMatch(new RegExp(` Send later with ${sendTool}\\.$`));
        expect(tool.description, `${name} ${tool.name}`).not.toContain('request_send');
      }
    }
  });
});

/**
 * The names the request log records for a call (#520). It used the list for an
 * app that takes no purchases, so every checkout call logged as "other".
 */
describe('every tool name, for the request log', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('names the tools that one app or a switch leaves out of its list', () => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'false');
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'false');
    vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
    const names = new LetterIrlServer().toolNames();
    for (const name of [
      'create_pack_checkout',
      'create_mail_checkout',
      'generate_image_for_mail',
      'request_send',
      'upload_photo_chunk',
      'send_letter'
    ]) {
      expect(names, name).toContain(name);
    }
    // The case #520 saw: the list without an app has no checkout.
    expect(new LetterIrlServer().listTools().map(tool => tool.name)).not.toContain('create_pack_checkout');
  });

  it('holds every name any app is offered, with the switches either way', () => {
    const names = new Set(new LetterIrlServer().toolNames());
    for (const on of ['true', 'false']) {
      vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', on);
      vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', on);
      vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', on === 'true' ? 'on' : 'off');
      for (const app of CLIENT_PROFILE_NAMES) {
        for (const tool of new LetterIrlServer().listTools(clientProfileNamed(app))) {
          expect(names.has(tool.name), `${app} ${tool.name}`).toBe(true);
        }
      }
    }
  });
});
