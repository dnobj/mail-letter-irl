import { describe, expect, it } from 'vitest';
import { LETTER_IRL_SERVER_INSTRUCTIONS } from '../../../src/mcp/serverInstructions.js';

/**
 * The refund line of the server instructions (#323).
 *
 * No tool can request or issue a refund; requests go to support by email
 * with the order id, and a person decides. The model has to be told this
 * explicitly or it improvises, and it improvises generously: it has already
 * called letters "credits" with nothing in its instructions saying so. Pin the
 * three things the line must do and the one thing it must never do.
 */
describe('server instructions: refunds', () => {
  const refundLine = LETTER_IRL_SERVER_INSTRUCTIONS.split('\n').find(line => /refund/i.test(line));

  it('tells the model refunds are asked for by email, with the order id, and decided by a person', () => {
    expect(refundLine).toBeDefined();
    expect(refundLine).toContain('support@letterirl.com');
    expect(refundLine).toMatch(/order id/i);
    expect(refundLine).toMatch(/get_purchase_status/);
    expect(refundLine).toMatch(/decided by a person/i);
  });

  it('forbids promising, estimating, or denying a refund', () => {
    expect(refundLine).toMatch(/never promise, estimate, or deny/i);
  });

  it('never calls letters credits', () => {
    expect(LETTER_IRL_SERVER_INSTRUCTIONS).not.toMatch(/credit/i);
  });
});
