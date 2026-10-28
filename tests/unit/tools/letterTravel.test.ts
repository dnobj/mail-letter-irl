/**
 * How a letter travels, beside its terms (#625): a letter's terms say whether
 * it goes as certified mail and in what words it is delivered, so that a card
 * which takes the terms of an answer takes these with them and its summary,
 * note, Delivery line, price and buttons all come from one answer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { letterPayment, travelFields } from '../../../src/tools/letterHelpers.js';
import type { MailOption } from '../../../src/config/products.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const CERTIFIED = { mailService: 'certified', deliveryClass: 'USPS Certified Mail' };
const RECEIPT = { mailService: 'certified_return_receipt', deliveryClass: 'USPS Certified Mail with an electronic return receipt' };
const FIRST_CLASS = { deliveryClass: 'USPS First-Class Mail', deliveryDisclaimer: 'USPS timing varies and can take longer.' };
const SIGNED_FOR = 'Certified mail is signed for at delivery';

const offer = () => {
  vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('travelFields', () => {
  it('names a certified service and says it is signed for, whether or not certified mail is offered', () => {
    for (const offered of [false, true]) {
      if (offered) offer();
      expect(travelFields('certified'), String(offered)).toMatchObject(CERTIFIED);
      expect(travelFields('certified').deliveryDisclaimer, String(offered)).toContain(SIGNED_FOR);
      expect(travelFields('certified_return_receipt'), String(offered)).toMatchObject(RECEIPT);
    }
  });

  it('says an ordinary letter is delivered First-Class only while certified mail is offered, and never names a service for it', () => {
    for (const value of [undefined, null, '', 'standard']) {
      expect(travelFields(value), String(value)).toEqual({});
    }
    offer();
    for (const value of [undefined, null, '', 'standard']) {
      expect(travelFields(value), String(value)).toEqual(FIRST_CLASS);
      expect(travelFields(value), String(value)).not.toHaveProperty('mailService');
    }
  });

  it('says nothing of text that is not a service: how that mail would go is not known', () => {
    for (const value of ['express', 'Certified', 'certified ']) {
      expect(travelFields(value), value).toEqual({});
      offer();
      expect(travelFields(value), value).toEqual({});
    }
  });
});

describe('a letter\'s terms (letterPayment) say how it travels', () => {
  const context = {
    user: { userId: 'user-1', creditsRemaining: 10 },
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    now: () => new Date('2026-09-30T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
  const terms = (option: MailOption) => letterPayment(option, 2, false, context, '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0');

  it('add how a certified letter travels, and that no balance pays for it', () => {
    const answer = terms({ mailType: 'letter', mailService: 'certified' });
    expect(answer).toMatchObject({ canSendNow: false, ...CERTIFIED });
    expect(answer.sendEligibility).toMatchObject({ packPays: false });
    expect(terms({ mailType: 'letter', mailService: 'certified_return_receipt' })).toMatchObject(RECEIPT);
  });

  it('add First-Class for an ordinary letter while certified mail is offered, and nothing while it is not', () => {
    expect(terms({ mailType: 'letter' })).toMatchObject({ canSendNow: true });
    expect(terms({ mailType: 'letter' })).not.toHaveProperty('deliveryClass');
    offer();
    expect(terms({ mailType: 'letter' })).toMatchObject({ canSendNow: true, ...FIRST_CLASS });
    expect(terms({ mailType: 'letter' })).not.toHaveProperty('mailService');
  });

  it('add nothing to a postcard, whatever is offered', () => {
    offer();
    for (const option of [{ mailType: 'postcard' as const }, { mailType: 'postcard' as const, postcardSize: '6x4' as const }]) {
      const answer = terms(option);
      expect(answer).not.toHaveProperty('mailService');
      expect(answer).not.toHaveProperty('deliveryClass');
      expect(answer).not.toHaveProperty('deliveryDisclaimer');
    }
  });
});
