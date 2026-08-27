import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every purchase credit grant must name its funding order (#152).
 *
 * Migration 023's protection against a double grant is a UNIQUE index on
 * `credit_ledger(source_order_id)`, partial on:
 *
 *   WHERE source_order_id IS NOT NULL AND source_type = 'purchase'
 *
 * A grant that sets `sourceType: 'purchase'` but leaves `sourceOrderId` unset
 * is therefore INVISIBLE to that index - the row inserts, and a second one for
 * the same order inserts beside it. The index looks like it protects the table;
 * for those rows it protects nothing.
 *
 * `creditService.addCredits` was in exactly that shape. It had no callers, so
 * nothing was broken, but the next caller would have reopened #152 with no
 * failing test anywhere to say so - the two live grant sites in commerceService
 * pass `sourceOrderId` and their unit tests pin it, which is precisely why the
 * third site's omission was invisible.
 *
 * This is a structural assertion rather than a behavioural one on purpose: the
 * defect is not in any one call, it is in the ease of writing the next one.
 */
describe('purchase grants are covered by the ledger unique index (#152)', () => {
  const root = path.resolve(fileURLToPath(new URL('../../../src/', import.meta.url)));

  async function sourceFiles(): Promise<string[]> {
    const found: string[] = [];
    for await (const entry of glob('**/*.ts', { cwd: root })) {
      found.push(path.join(root, entry));
    }
    return found;
  }

  /** Object literals that set `sourceType: 'purchase'`, with their location. */
  function purchaseGrants(
    fileName: string,
    text: string
  ): Array<{ line: number; properties: Set<string> }> {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const grants: Array<{ line: number; properties: Set<string> }> = [];

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set<string>();
        let isPurchase = false;
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          names.add(property.name.text);
          if (
            property.name.text === 'sourceType' &&
            ts.isStringLiteralLike(property.initializer) &&
            property.initializer.text === 'purchase'
          ) {
            isPurchase = true;
          }
        }
        if (isPurchase) {
          grants.push({
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            properties: names
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return grants;
  }

  it('every purchase grant in src passes sourceOrderId', async () => {
    const files = await sourceFiles();
    const uncovered: string[] = [];
    let total = 0;

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (!text.includes("sourceType: 'purchase'")) continue;
      for (const grant of purchaseGrants(file, text)) {
        total += 1;
        if (!grant.properties.has('sourceOrderId')) {
          uncovered.push(`${path.relative(root, file)}:${grant.line}`);
        }
      }
    }

    expect(uncovered).toEqual([]);
    // A guard that finds nothing to guard passes vacuously. If the grant sites
    // are ever renamed or restructured away from an object literal, this drops
    // to zero and the assertion above stops meaning anything.
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
