import { describe, expect, it } from 'vitest';
import {
  createPackCheckoutInputZ,
  saveStationeryDesignInputZ,
  setMailServiceInputZ
} from '../../../src/zodSchemas.js';

/**
 * A required choice names its options when it is missing (#681). From MCP SDK 1.31 a missing field is refused as
 * "Required" alone; zod's message for a wrong value already lists the options, so a missing one says them too.
 */
describe('required choices name their options when missing', () => {
  const issueFor = (schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } }, input: unknown, field: string) => {
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    return parsed.error!.issues.find(issue => issue.path[0] === field)!.message;
  };

  it('the mail service', () => {
    expect(issueFor(setMailServiceInputZ, { draftId: 'draft-1' }, 'mailService')).toBe(
      'Required: one of standard, certified, certified_return_receipt'
    );
  });

  it('the pack to buy', () => {
    expect(issueFor(createPackCheckoutInputZ, {}, 'pack')).toBe('Required: one of starter, regular, power');
  });

  it("a saved design's face, ornament and tone", () => {
    const input = { name: 'Garden', ruled: true };
    expect(issueFor(saveStationeryDesignInputZ, input, 'face')).toMatch(/^Required: one of serif, typewriter, handwritten$/);
    expect(issueFor(saveStationeryDesignInputZ, input, 'ornament')).toMatch(/^Required: one of none, /);
    expect(issueFor(saveStationeryDesignInputZ, input, 'tone')).toMatch(/^Required: one of black, /);
  });

  it('still names the options for a wrong value, and takes a right one', () => {
    expect(issueFor(createPackCheckoutInputZ, { pack: 'huge' }, 'pack')).toMatch(/starter.*regular.*power/);
    expect(createPackCheckoutInputZ.safeParse({ pack: 'starter' }).success).toBe(true);
  });
});
