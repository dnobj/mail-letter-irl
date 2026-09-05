/**
 * Documentation that goes stale silently (#301).
 *
 * Nothing else in CI reads `docs/`, so every correction made by hand decays the
 * moment the code moves. Two classes have now drifted repeatedly and are
 * mechanically checkable, so they are checked rather than re-audited:
 *
 * 1. TOOLS. #311 and #312 added three tools and `docs/tool-apis.md` documented
 *    none of them. Nobody noticed until the file was read for another reason.
 *
 * 2. BOOT RULES. `docs/deployment.md` claimed to list what production refuses.
 *    It named ONE of twenty-nine. Every other refusal arrived unexplained by
 *    the guide whose job is explaining them - the failure #301 was filed about,
 *    at seven times the scale it was filed at.
 *
 * Both assert PRESENCE, which is all a test can do. Whether the prose beside
 * each entry is any use is a review question, and naming a rule without saying
 * what to do about it would pass here while helping nobody.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LetterIrlServer } from '../../../src/server.js';

const ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string): string =>
  fs.readFileSync(path.join(ROOT, relative), 'utf-8');

describe('docs/tool-apis.md covers the tools that exist', () => {
  const toolNames = new LetterIrlServer().listTools().map(tool => tool.name);
  const doc = read('docs/tool-apis.md');

  it('has tools to check', () => {
    expect(toolNames.length).toBeGreaterThan(15);
  });

  it.each(toolNames)('documents %s', name => {
    expect(doc).toContain(`\`${name}\``);
  });
});

describe('docs/deployment.md explains every boot refusal', () => {
  // Scraped from source rather than imported: the rules are pushed into
  // `findings` inside conditional branches, not declared in a table, so there
  // is nothing to enumerate at runtime. The thing under test is whether the
  // DOCUMENT names them, and the ids live in the source.
  const source = read('src/config/deploymentConfig.ts');
  const ruleIds = [
    ...new Set(
      Array.from(source.matchAll(/rule: '([a-z_]+\.[a-z_]+)'/g)).map(match => match[1])
    )
  ].sort();
  const doc = read('docs/deployment.md');

  it('finds the rules in the validator', () => {
    // Guards the suite below against passing vacuously if the `rule:` shape
    // ever changes and the scrape silently returns nothing.
    expect(ruleIds.length).toBeGreaterThan(20);
    expect(ruleIds).toContain('database.tls_required');
  });

  it.each(ruleIds)('explains %s', rule => {
    expect(doc).toContain(`\`${rule}\``);
  });

  it('does not document rules the validator cannot raise', () => {
    // The other direction: a rule removed from the code should lose its row,
    // or the guide starts describing refusals that can no longer happen.
    //
    // Scoped to the reference section rather than the whole file. The document
    // legitimately names diagnostics from elsewhere that share the dotted
    // shape — `database.migration_lock_timeout` and
    // `database.migration_rollback_failed` come from `src/cli/migrate.ts` — and
    // a whole-file check flagged both as phantom boot rules.
    const start = doc.indexOf('## Boot validation rules');
    expect(start, 'the rules reference section is missing').toBeGreaterThan(-1);
    const after = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, after === -1 ? undefined : after);

    const documented = [
      ...new Set(Array.from(section.matchAll(/`([a-z_]+\.[a-z_]+)`/g)).map(match => match[1]))
    ];

    expect(documented.filter(candidate => !ruleIds.includes(candidate))).toEqual([]);
  });
});
