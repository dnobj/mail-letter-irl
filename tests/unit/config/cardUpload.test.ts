/**
 * The switches for photo upload through the card (#474, phase 3).
 *
 * The upload is off unless an operator turns it on in so many words, a typo
 * included. The daily count has a default a person never meets and refuses a
 * value it cannot honour. The card sends the photo itself only in an app that
 * shows our cards and gives them no file store: every such app but ChatGPT.
 */

import { describe, expect, it } from 'vitest';
import { dailyPhotoUploadsPerAccount, isCardUploadEnabled, uploadsThroughCard } from '../../../src/config/cardUpload.js';
import { clientProfileNamed } from '../../../src/auth/clientProfiles.js';

const env = (value?: string, name = 'LETTER_IRL_CARD_UPLOAD_ENABLED'): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [name]: value };

describe('LETTER_IRL_CARD_UPLOAD_ENABLED', () => {
  it('is off unless explicitly on', () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'ture']) expect(isCardUploadEnabled(env(value)), String(value)).toBe(false);
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) expect(isCardUploadEnabled(env(value)), value).toBe(true);
  });
});

describe('LETTER_IRL_PHOTO_UPLOADS_PER_DAY', () => {
  const perDay = (value?: string) => dailyPhotoUploadsPerAccount(env(value, 'LETTER_IRL_PHOTO_UPLOADS_PER_DAY'));

  it('is 20 unless set', () => {
    expect(perDay()).toBe(20);
  });

  it('takes a whole number from 1 to 1000, and falls back to 20 for anything else', () => {
    expect(perDay('5')).toBe(5);
    expect(perDay('1000')).toBe(1000);
    for (const value of ['0', '1001', '-3', '1e3', 'ten']) expect(perDay(value), value).toBe(20);
  });
});

describe('where the card sends the photo itself', () => {
  const on = env('true');

  it('is Claude, while the switch is on', () => {
    expect(uploadsThroughCard(clientProfileNamed('claude'), on)).toBe(true);
    expect(uploadsThroughCard(clientProfileNamed('claude'), env())).toBe(false);
  });

  it('is never ChatGPT, whose card hands on a link, nor an app that shows no card', () => {
    expect(uploadsThroughCard(clientProfileNamed('chatgpt'), on)).toBe(false);
    for (const name of ['claude_code', 'codex', 'vscode'] as const) {
      expect(uploadsThroughCard(clientProfileNamed(name), on), name).toBe(false);
    }
  });
});
