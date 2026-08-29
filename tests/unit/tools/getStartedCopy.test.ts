import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStartedTool } from '../../../src/tools/getStarted.js';

/**
 * get_started must describe the payment routes this deployment actually has
 * (#229).
 *
 * The card carried one static sentence: "Before sending mail, buy pre-paid
 * letter sends on letterirl.com." True while Pay & Send was dark in every
 * deployed environment, and a lie the moment JIT_PURCHASE_ENABLED flipped -
 * with nothing to catch it, because copy about a flagged feature is exactly the
 * thing nobody re-reads when the flag changes.
 *
 * The widget is not a second source to keep in step: GetStartedCard.html
 * renders `state.purchaseStep` verbatim, so this string is the only copy.
 */

const purchaseStep = async (): Promise<string> => {
  const output = (await getStartedTool.handler(
    {} as never,
    {} as never
  )) as { purchaseStep: string };
  return output.purchaseStep;
};

afterEach(() => vi.unstubAllEnvs());

describe('get_started payment copy', () => {
  it('offers pre-pay only while Pay & Send is off', () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'false');
    return purchaseStep().then(copy => {
      expect(copy).toContain('pre-paid');
      // The claim that must not survive the flag flipping.
      expect(copy.toLowerCase()).not.toContain('pay for a single');
    });
  });

  it('offers BOTH routes once Pay & Send is on', async () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const copy = await purchaseStep();

    expect(copy).toContain('pre-paid');
    expect(copy).toContain('pay for a single');
    // "Before sending mail, buy..." states a precondition that is no longer
    // true; a customer can now send without ever visiting the site.
    expect(copy).not.toMatch(/^Before sending mail/);
  });

  it('is read per call, so a restart is enough to change it', async () => {
    // Captured at module load, this would need a redeploy to correct - and a
    // test would need a fresh import to see it, which is how the static string
    // went unnoticed in the first place.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'false');
    const off = await purchaseStep();
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const on = await purchaseStep();

    expect(off).not.toBe(on);
  });

  it('treats anything other than the exact flag value as off', async () => {
    // isJitPurchaseEnabled is a strict `=== 'true'` opt-in, so a typo leaves
    // Pay & Send off. The copy must agree with the feature rather than
    // advertise a route the checkout will refuse.
    for (const raw of ['ture', 'TRUE', '1', 'yes', '']) {
      vi.stubEnv('JIT_PURCHASE_ENABLED', raw);
      expect(await purchaseStep(), `JIT_PURCHASE_ENABLED=${raw}`).toMatch(/^Before sending mail/);
    }
  });
});
