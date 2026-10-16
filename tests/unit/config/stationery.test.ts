/**
 * Stationery's flag (#563): off unless explicitly on, and offered only while
 * our renderer draws the previews, since only it draws a theme.
 */

import { describe, expect, it } from 'vitest';
import { isStationeryEnabled, isStationeryOffered } from '../../../src/config/stationery.js';

describe('isStationeryEnabled', () => {
  it('is on only for an explicit affirmative', () => {
    for (const value of ['true', '1', 'yes', 'on', 'enabled', ' TRUE ']) {
      expect(isStationeryEnabled({ LETTER_IRL_STATIONERY_ENABLED: value }), value).toBe(true);
    }
    for (const value of ['', 'false', '0', 'off', 'ture']) {
      expect(isStationeryEnabled({ LETTER_IRL_STATIONERY_ENABLED: value }), value).toBe(false);
    }
    expect(isStationeryEnabled({})).toBe(false);
  });
});

describe('isStationeryOffered', () => {
  it('needs the flag and our renderer both', () => {
    expect(isStationeryOffered({ LETTER_IRL_STATIONERY_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(true);
    expect(isStationeryOffered({ LETTER_IRL_STATIONERY_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' })).toBe(false);
    expect(isStationeryOffered({ LETTER_IRL_STATIONERY_ENABLED: 'true' })).toBe(false);
    expect(isStationeryOffered({ LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(false);
  });
});
