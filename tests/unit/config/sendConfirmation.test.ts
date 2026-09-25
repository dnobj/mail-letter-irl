import { describe, expect, it } from 'vitest';
import {
  isSendConfirmationEnabled,
  sendConfirmationUrl,
  websiteBaseUrl,
  websiteClientId
} from '../../../src/config/sendConfirmation.js';
import { validateDeploymentConfig } from '../../../src/config/deploymentConfig.js';

/** The send rule's settings (#470). */
describe('the send rule settings', () => {
  it('is off unless explicitly enabled, and a typo leaves it off', () => {
    expect(isSendConfirmationEnabled({})).toBe(false);
    expect(isSendConfirmationEnabled({ LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'ture' })).toBe(false);
    expect(isSendConfirmationEnabled({ LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'false' })).toBe(false);
    expect(isSendConfirmationEnabled({ LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true' })).toBe(true);
    expect(isSendConfirmationEnabled({ LETTER_IRL_SEND_CONFIRMATION_ENABLED: ' TRUE ' })).toBe(true);
  });

  it('points at the website, falling back to the gift landing address, then letterirl.com', () => {
    expect(websiteBaseUrl({})).toBe('https://letterirl.com');
    expect(websiteBaseUrl({ LETTER_IRL_GIFT_LANDING_BASE_URL: 'https://dev.example/' })).toBe('https://dev.example');
    expect(
      websiteBaseUrl({
        LETTER_IRL_GIFT_LANDING_BASE_URL: 'https://gift.example',
        LETTER_IRL_WEBSITE_BASE_URL: ' https://site.example// '
      })
    ).toBe('https://site.example');
    expect(websiteBaseUrl({ LETTER_IRL_WEBSITE_BASE_URL: '   ', LETTER_IRL_GIFT_LANDING_BASE_URL: 'https://gift.example' })).toBe(
      'https://gift.example'
    );
  });

  it('builds the confirmation link from the draft id, encoded', () => {
    const env = { LETTER_IRL_WEBSITE_BASE_URL: 'https://site.example' };
    expect(sendConfirmationUrl('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', env)).toBe(
      'https://site.example/confirm/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
    );
    expect(sendConfirmationUrl('a/b?c', env)).toBe('https://site.example/confirm/a%2Fb%3Fc');
  });

  it('names the website application only when it is set', () => {
    expect(websiteClientId({})).toBeUndefined();
    expect(websiteClientId({ LETTER_IRL_WEBSITE_CLIENT_ID: '   ' })).toBeUndefined();
    expect(websiteClientId({ LETTER_IRL_WEBSITE_CLIENT_ID: ' WebsiteClient01 ' })).toBe('WebsiteClient01');
  });
});

describe('the boot finding for a send rule with no website application', () => {
  const rule = 'send_confirmation.website_client_missing';
  const findingOf = (env: NodeJS.ProcessEnv) =>
    validateDeploymentConfig(env).findings.find((finding) => finding.rule === rule);

  it('says nothing while the rule is off, or once the application is named', () => {
    expect(findingOf({})).toBeUndefined();
    expect(
      findingOf({ LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true', LETTER_IRL_WEBSITE_CLIENT_ID: 'WebsiteClient01' })
    ).toBeUndefined();
  });

  it('warns outside production and refuses to boot in production', () => {
    expect(findingOf({ LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true' })?.severity).toBe('warning');
    expect(
      findingOf({
        LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true',
        LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'production',
        NODE_ENV: 'production'
      })?.severity
    ).toBe('error');
  });
});
