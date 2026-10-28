/**
 * The words editor (#647): a letter's words change in place while room to
 * write is offered, and on one page while LETTER_IRL_WORDS_EDITOR_ENABLED is
 * on with our renderer.
 */
import { describe, expect, it } from 'vitest';
import { isWordsEditorOffered } from '../../../src/config/wordsEditor.js';

describe('isWordsEditorOffered', () => {
  it('is on while room to write is offered', () => {
    expect(isWordsEditorOffered({ LETTER_IRL_ROOM_TO_WRITE_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf', JIT_PURCHASE_ENABLED: 'true' })).toBe(true);
  });

  it('is on with the editor flag and our renderer, without room to write', () => {
    expect(isWordsEditorOffered({ LETTER_IRL_WORDS_EDITOR_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(true);
  });

  it('is off without our renderer, without the flag, and for a flag that is not exactly on', () => {
    expect(isWordsEditorOffered({ LETTER_IRL_WORDS_EDITOR_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' })).toBe(false);
    expect(isWordsEditorOffered({ LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(false);
    expect(isWordsEditorOffered({ LETTER_IRL_WORDS_EDITOR_ENABLED: 'yes please', LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(false);
    expect(isWordsEditorOffered({})).toBe(false);
  });
});
