/**
 * The dashboard checkout endpoint used to carry its own copy of the pack
 * product codes - a fourth hand-kept list beside the definitions, the manifest
 * env names and the reconciliation credits map, which is the drift shape
 * #160/#270/#275 keep producing. Adding a tier in products.ts prices it,
 * validates its env var, resolves it and reports it in /readyz, while the
 * hand-kept list answered 400 and left the Buy button dead for a product every
 * other layer believed was live (#278 review round 3).
 *
 * A source guard rather than a request test: the list is a local const inside
 * the handler, and this is the same technique readyz.test.ts uses to prove the
 * route is actually registered.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PACK_PRODUCTS } from '../../../src/config/products.js';

describe('dashboard pack product list (#275)', () => {
  it('derives the accepted product codes from the shared table', async () => {
    const source = await readFile('src/api/dashboardApiHandler.ts', 'utf8');

    expect(source).toContain('PACK_PRODUCTS.map(product => product.productCode)');
    // No hand-written pack code may reappear as a literal in this file.
    for (const product of PACK_PRODUCTS) {
      expect(source, product.productCode).not.toContain('\'' + product.productCode + '\'');
    }
  });
});
