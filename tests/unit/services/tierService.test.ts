import { describe, expect, it, vi } from 'vitest';

/**
 * A proportional refund (#323) returns part of a pack and leaves the purchase
 * standing. The tier calculation treats a `refund` ledger row linked to a
 * purchase as "this purchase was returned", so without an exclusion a goodwill
 * refund of one letter would silently demote a trusted customer. The same
 * predicate is inlined in the whole-pack revocation's tier recompute; both are
 * pinned here by the SQL they issue, because the decision lives in the query.
 */

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction,
  pool: {}
}));

import { calculateUserTier } from '../../../src/services/tierService.js';

const EXCLUSION = "COALESCE(ref.source_metadata->>'reason', '') <> 'partial_refund'";

describe('tier calculation and proportional refunds', () => {
  it('does not count a partially refunded pack as a returned purchase', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await calculateUserTier('user-1');
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toContain("ref.source_type = 'refund'");
    expect(sql).toContain('ref.related_ledger_id = cl.ledger_id');
    expect(sql).toContain(EXCLUSION);
  });

  it('keeps the inline recompute in the whole-pack revocation in step', async () => {
    // Read the source rather than drive the revocation: the predicate is a
    // string inside a query, and the two copies must say the same thing.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../src/services/commerceService.ts', import.meta.url), 'utf8');
    const inline = "COALESCE(refund.source_metadata->>'reason', '') <> 'partial_refund'";
    expect(source).toContain(inline);
    expect(source).toContain("refund.related_ledger_id = purchase.ledger_id");
  });
});
