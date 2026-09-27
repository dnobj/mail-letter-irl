/**
 * The image switch (LETTER_IRL_IMAGE_GEN_MODE, src/config/imageGeneration.ts).
 *
 * "off" now means the feature is gone: no app is offered the tool, no purchase
 * grants image generations, and nothing reports how many are left. What "off"
 * used to mean, a listed tool that only hands back the redirect card, is now
 * "redirect".
 */

import { describe, expect, it } from 'vitest';
import {
  imageGenMode,
  isImageGenerationOff,
  offersImageGeneration
} from '../../../src/config/imageGeneration.js';
import { clientProfileNamed } from '../../../src/auth/clientProfiles.js';

const env = (value?: string) =>
  (value === undefined ? {} : { LETTER_IRL_IMAGE_GEN_MODE: value }) as NodeJS.ProcessEnv;

describe('the image switch', () => {
  it('reads each mode, ignoring case and spaces', () => {
    expect(imageGenMode(env('off'))).toBe('off');
    expect(imageGenMode(env(' OFF '))).toBe('off');
    expect(imageGenMode(env('redirect'))).toBe('redirect');
    expect(imageGenMode(env('mobile_only'))).toBe('mobile_only');
    expect(imageGenMode(env('on'))).toBe('on');
  });

  it('reads an absent or unknown value as on, as it always has', () => {
    expect(imageGenMode(env())).toBe('on');
    expect(imageGenMode(env('disabled'))).toBe('on');
    expect(imageGenMode(env(''))).toBe('on');
  });

  it('is off only for off', () => {
    expect(isImageGenerationOff(env('off'))).toBe(true);
    for (const value of [undefined, 'on', 'redirect', 'mobile_only']) {
      expect(isImageGenerationOff(env(value)), String(value)).toBe(false);
    }
  });

  it('offers the tool where the app allows it, until the switch is off', () => {
    const chatgpt = clientProfileNamed('chatgpt');
    const claude = clientProfileNamed('claude');
    expect(offersImageGeneration(chatgpt, env())).toBe(true);
    expect(offersImageGeneration(chatgpt, env('redirect'))).toBe(true);
    expect(offersImageGeneration(chatgpt, env('off'))).toBe(false);
    // Claude is never offered it (#490), whatever the switch says.
    expect(offersImageGeneration(claude, env())).toBe(false);
    expect(offersImageGeneration(claude, env('off'))).toBe(false);
  });
});
