import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARRIER_TRACKING_NUMBER_SHAPE, MAIL_SERVICES, certifiedFactsOf, isCertifiedMailOffered, uspsTrackingUrl } from '../../../src/config/certifiedMail.js';
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

describe('the USPS page for a tracking number (#625)', () => {
  it('links the characters of the number alone, without the groups\' spaces and hyphens', () => {
    expect(uspsTrackingUrl('9407100000000000000000')).toBe(
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000'
    );
    expect(uspsTrackingUrl('9407 1000 0000 0000 0000 00')).toBe(
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000'
    );
    expect(uspsTrackingUrl('9407-1000-0000-0000-0000-00')).toBe(
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000'
    );
  });

  it('cannot be made to carry anything but the label', () => {
    expect(uspsTrackingUrl('9407&x=1#frag')).toBe('https://tools.usps.com/go/TrackConfirmAction?tLabels=9407%26x%3D1%23frag');
  });
});

describe('what a letter row says about certified mail (#625)', () => {
  it('says nothing for an ordinary letter, however the column is left', () => {
    for (const mail_service of ['standard', '', null, undefined]) {
      expect(certifiedFactsOf({ mail_service, carrier_tracking_number: null })).toBeUndefined();
    }
    expect(certifiedFactsOf({})).toBeUndefined();
  });

  it('says nothing for text that is not one of the two services, and prices nothing by it', () => {
    for (const mail_service of ['Certified', 'express', 7, {}]) {
      expect(certifiedFactsOf({ mail_service, carrier_tracking_number: '9407100000000000000000' })).toBeUndefined();
    }
  });

  it('reads the service from its own column and nowhere else', () => {
    // A number that happens to spell a service is still only a number.
    for (const mail_service of [undefined, null, 7]) {
      expect(certifiedFactsOf({ mail_service, carrier_tracking_number: 'certified' })).toBeUndefined();
    }
  });

  it('gives the service alone until there is a number', () => {
    for (const carrier_tracking_number of [null, undefined, '', '   ', 42]) {
      expect(certifiedFactsOf({ mail_service: 'certified', carrier_tracking_number })).toEqual({ mailService: 'certified' });
    }
  });

  it('gives the number, trimmed, with its link', () => {
    expect(certifiedFactsOf({ mail_service: 'certified_return_receipt', carrier_tracking_number: ' 9407 1000 0000 0000 0000 00 ' })).toEqual({
      mailService: 'certified_return_receipt',
      carrierTrackingNumber: '9407 1000 0000 0000 0000 00',
      carrierTrackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000'
    });
  });
});

describe('the carrier number this code will show (#625)', () => {
  it.each(['9407 1000 0000 0000 0000 00', '9407-1000-0000-0000-0000-00', '94071000000000000000000', 'ABC12345', 'A'.padEnd(40, '1')])(
    'shows %j',
    number => {
      expect(certifiedFactsOf({ mail_service: 'certified', carrier_tracking_number: number })).toMatchObject({ carrierTrackingNumber: number });
    }
  );

  it.each(['short', 'A'.padEnd(41, '1'), '9407/1000/0000', '<b>9407100000000000000000</b>', 'javascript:alert(1)', ' - 9407 1000 0000', '9407\n1000 0000 0000'])(
    'shows no number for %j, though the column holds it',
    number => {
      expect(certifiedFactsOf({ mail_service: 'certified', carrier_tracking_number: number })).toEqual({ mailService: 'certified' });
    }
  );

  it("is the shape the status sync stores, held equal to the printer provider's", () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/services/providers/PostGridProvider.ts'), 'utf8');
    const stored = /const CARRIER_TRACKING_NUMBER = (\/\^.*\$\/);/.exec(source);
    expect(stored, 'the provider names its shape').not.toBeNull();
    expect(CARRIER_TRACKING_NUMBER_SHAPE.toString()).toBe(stored![1]);
  });
});
