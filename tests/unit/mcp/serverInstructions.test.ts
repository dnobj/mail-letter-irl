import { describe, expect, it } from 'vitest';
import { LETTER_IRL_SERVER_INSTRUCTIONS } from '../../../src/mcp/serverInstructions.js';

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
