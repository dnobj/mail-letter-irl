import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildServerInstructions,
  LETTER_IRL_SERVER_INSTRUCTIONS
} from '../../../src/mcp/serverInstructions.js';
import { clientProfileNamed } from '../../../src/auth/clientProfiles.js';

/**
 * The refund line of the server instructions (#323).
 *
 * No tool can request or issue a refund; requests go to support by email
 * with the order id, and a person decides. The model has to be told this
 * explicitly or it improvises, and it improvises generously: it has already
 * called letters "credits" with nothing in its instructions saying so. Pin the
 * three things the line must do and the one thing it must never do.
 */
describe('server instructions: refunds', () => {
  const refundLine = LETTER_IRL_SERVER_INSTRUCTIONS.split('\n').find(line => /refund/i.test(line));

  it('tells the model refunds are asked for by email, with the order id, and decided by a person', () => {
    expect(refundLine).toBeDefined();
    expect(refundLine).toContain('support@letterirl.com');
    expect(refundLine).toMatch(/order id/i);
    expect(refundLine).toMatch(/get_purchase_status/);
    expect(refundLine).toMatch(/decided by a person/i);
  });

  it('forbids promising, estimating, or denying a refund', () => {
    expect(refundLine).toMatch(/never promise, estimate, or deny/i);
  });

  it('never calls letters credits', () => {
    expect(LETTER_IRL_SERVER_INSTRUCTIONS).not.toMatch(/credit/i);
  });
});

/**
 * The lost-call line of the server instructions (#411).
 *
 * On ChatGPT web a call approved with "Allow once" can vanish inside the host.
 * The model still wrote "Preview created successfully" with no result behind
 * it. The line ties every claim to a field the model can check, and points at
 * the card's own recovery.
 */
describe('server instructions: calls that return nothing', () => {
  const line = LETTER_IRL_SERVER_INSTRUCTIONS.split('\n').find(entry => /returns no result/i.test(entry));

  it('ties a preview to a draftId and a checkout to a checkoutUrl', () => {
    expect(line).toBeDefined();
    expect(line).toMatch(/preview exists only when the preview tool's result includes a draftId/);
    expect(line).toMatch(/checkout only when its result includes a checkoutUrl/);
  });

  it('says a call that returned nothing did not complete, and names the card button', () => {
    expect(line).toMatch(/say it did not complete/);
    expect(line).toContain('Create my preview');
  });

  it('forbids describing what was not received', () => {
    expect(line).toMatch(/Never describe a draft, order or checkout you did not receive/);
  });

  it('names the same button label the preview cards show', async () => {
    const { readFile } = await import('fs/promises');
    for (const card of ['LetterPreviewCard', 'PostcardPreviewCard']) {
      const html = await readFile(new URL(`../../../widgets/${card}.html`, import.meta.url), 'utf8');
      expect(html, card).toContain('const RETRY_LABEL = "Create my preview";');
    }
  });
});

/**
 * The duplicate line of the server instructions (#412).
 *
 * A send or checkout refused because the same mail went out recently must not
 * be repeated with sendAnotherCopy unless the user asks for another copy.
 */
describe('server instructions: the same mail twice', () => {
  const line = LETTER_IRL_SERVER_INSTRUCTIONS.split('\n').find(entry => /sendAnotherCopy/.test(entry));

  it('names every tool that can refuse, and the flag', () => {
    expect(line).toBeDefined();
    expect(line).toMatch(/send_letter, send_postcard or create_mail_checkout/);
    expect(line).toMatch(/already sent, paid for, or is awaiting payment/);
  });

  it('allows another copy only when the user asks for one', () => {
    expect(line).toMatch(/tell the user/);
    expect(line).toMatch(/sendAnotherCopy: true only if they ask for another copy/);
  });
});

/**
 * The instructions another app reads (#484). They are ChatGPT's, except where
 * a line would be false there: ChatGPT's own image generation and library,
 * and the preview card's Create my preview button.
 */
describe('server instructions in an app other than ChatGPT', () => {
  const claude = buildServerInstructions(false, clientProfileNamed('claude')).split('\n');
  const line = (pattern: RegExp) => claude.find(entry => pattern.test(entry));

  it('make generate_image_for_mail the way to make an image, where Letter IRL makes them', () => {
    // An app with no image generation of its own that is still offered
    // Letter IRL's; Claude is not (#467, below).
    const images = buildServerInstructions(false, clientProfileNamed('vscode'))
      .split('\n')
      .find(entry => /generate_image_for_mail/.test(entry));
    expect(images).toBeDefined();
    expect(images).toContain('rather than refusing');
    expect(images).toContain('an image of their own');
    expect(images).not.toMatch(/ChatGPT|image_gen|addressed to Letter IRL|copy-ready prompt/);
  });

  it('tell Claude that Letter IRL makes no images there (#467)', () => {
    expect(line(/generate_image_for_mail/)).toBeUndefined();
    expect(line(/make images/)).toBe(
      'Letter IRL does not make images in this app. For image mail, use an image the user already has: pass a link to it as imageUrl.'
    );
  });

  it("offer an upload without ChatGPT's library", () => {
    const upload = line(/open upload_image/);
    expect(upload).toBeDefined();
    expect(upload).toContain('so the user can upload it');
    expect(upload).not.toMatch(/ChatGPT|library/);
  });

  it('recover a lost call without naming a card button or a checkout, where no card shows', () => {
    const lost = buildServerInstructions(false, clientProfileNamed('vscode'))
      .split('\n')
      .find(entry => /returns no result/.test(entry));
    expect(lost).toContain('say it did not complete and offer to try again.');
    expect(lost).not.toMatch(/\bcard\b|Create my preview|checkout/);
    // The claims the line exists to tie down, less the checkout this app is
    // not offered (#475).
    expect(lost).toMatch(/preview exists only when the preview tool's result includes a draftId\./);
    expect(lost).toMatch(/Never describe a draft or order you did not receive/);
  });

  it("name Claude's card button for a lost call, and still no checkout (#474)", () => {
    const lost = line(/returns no result/);
    expect(lost).toContain('the preview card offers a Create my preview button, or offer to try again.');
    expect(lost).not.toMatch(/checkout/);
    expect(lost).toMatch(/Never describe a draft or order you did not receive/);
  });

  it('name no create_mail_checkout, which Claude is not offered, for the same mail twice', () => {
    const off = line(/another copy/);
    expect(off).toBe(
      'If send_letter or send_postcard says the same mail was already sent, tell the user and repeat the call with sendAnotherCopy: true only if they ask for another copy.'
    );
    // Under the send rule the card and the page ask about another copy
    // themselves. Claude shows our card (#474); an app without one has only
    // the page.
    const on = (app: 'claude' | 'vscode') =>
      buildServerInstructions(true, clientProfileNamed(app))
        .split('\n')
        .find(entry => /another copy/.test(entry));
    expect(on('claude')).toBe(
      'If the same mail was sent recently, the preview card or the confirmation page says so and offers another copy itself.'
    );
    expect(on('vscode')).toBe('If the same mail was sent recently, the confirmation page says so and offers another copy itself.');
  });

  it('keep the refund line word for word', () => {
    expect(line(/refund/i)).toBe(LETTER_IRL_SERVER_INSTRUCTIONS.split('\n').find(entry => /refund/i.test(entry)));
  });
});

/**
 * A photo the upload card sends itself (#474, phase 3). In an app with no
 * file store for cards (Claude), the card sends the photo to Letter IRL and
 * leaves no imageUrl, so the model must call the preview with no image. Said
 * only there, and only while the switch is on.
 */
describe('server instructions: a photo the card sends itself', () => {
  afterEach(() => vi.unstubAllEnvs());
  const uploadLine = (name: 'chatgpt' | 'claude' | 'claude_code') =>
    buildServerInstructions(false, clientProfileNamed(name))
      .split('\n')
      .find(entry => /^If a specific image fails to hand off/.test(entry));
  const CARD_STEP =
    'The card sends the photo to Letter IRL and then asks for the preview in the conversation: call the preview tool with no image and no imageUrl, and Letter IRL uses the photo just uploaded.';

  it('tells Claude to call the preview with no image, once the switch is on', () => {
    expect(uploadLine('claude')).not.toContain(CARD_STEP);
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    expect(uploadLine('claude')).toBe(
      `If a specific image fails to hand off to a preview tool, open upload_image so the user can upload it - that preserves the exact image they approved. ${CARD_STEP}`
    );
  });

  it('offers Claude the upload card for an image that is not at a link, once the switch is on', () => {
    const imageLine = () =>
      buildServerInstructions(false, clientProfileNamed('claude'))
        .split('\n')
        .find(entry => /make images/.test(entry));
    const off = imageLine();
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    expect(imageLine()).toBe(
      `${off} If the image is on their device or attached in the chat, rather than at a link, open upload_image so they can upload it.`
    );
  });

  it("says nothing of it to ChatGPT, whose card hands on a link, or to an app that shows no card", () => {
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    // ChatGPT's instructions stay word for word.
    expect(buildServerInstructions(false, clientProfileNamed('chatgpt'))).toBe(LETTER_IRL_SERVER_INSTRUCTIONS);
    const claudeCode = buildServerInstructions(false, clientProfileNamed('claude_code'));
    expect(claudeCode).not.toContain(CARD_STEP);
    expect(claudeCode).not.toContain('attached in the chat');
    expect(uploadLine('claude_code')).toBeDefined();
  });
});
