import { describe, expect, it } from 'vitest';
import { MAIL_SERVICES, isCertifiedMailOffered } from '../../../src/config/certifiedMail.js';
import { CERTIFIED_MAIL_FLAG } from '../../../src/config/products.js';

/**
 * #625: the letter previews offer certified mail only while its flag is on and
 * Pay & Send is on, the only way to pay for it (#579).
 */
describe('certified mail is offered (#625)', () => {
  const on = { [CERTIFIED_MAIL_FLAG]: 'true', JIT_PURCHASE_ENABLED: 'true' };

  it('needs its flag and Pay & Send', () => {
    expect(isCertifiedMailOffered(on)).toBe(true);
    expect(isCertifiedMailOffered({ JIT_PURCHASE_ENABLED: 'true' })).toBe(false);
    expect(isCertifiedMailOffered({ [CERTIFIED_MAIL_FLAG]: 'true' })).toBe(false);
    expect(isCertifiedMailOffered({})).toBe(false);
  });

  it('is off unless the flag is explicitly on: a typo leaves it off', () => {
    for (const value of ['false', '0', 'no', 'off', '', 'ture', 'maybe']) {
      expect(isCertifiedMailOffered({ ...on, [CERTIFIED_MAIL_FLAG]: value }), value).toBe(false);
    }
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'enabled']) {
      expect(isCertifiedMailOffered({ ...on, [CERTIFIED_MAIL_FLAG]: value }), value).toBe(true);
    }
  });

  it('is off when Pay & Send is not explicitly on', () => {
    for (const value of ['false', '', 'yes', 'ture']) {
      expect(isCertifiedMailOffered({ [CERTIFIED_MAIL_FLAG]: 'true', JIT_PURCHASE_ENABLED: value }), value).toBe(false);
    }
  });

  it('lists the services in the order they are offered, standard first', () => {
    expect(MAIL_SERVICES).toEqual(['standard', 'certified', 'certified_return_receipt']);
  });
});
