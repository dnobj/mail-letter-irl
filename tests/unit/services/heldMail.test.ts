/**
 * Held mail's one predicate (#693): the SQL fragment and its twin for a job already read.
 * Where each reader uses it: letterJobService.test.ts (the pause count, the release),
 * accountErasureService.test.ts (the gate), jobCommands.test.ts (the admin panel).
 */

import { describe, expect, it } from 'vitest';
import { heldMailJobSql, isHeldMailJobState } from '../../../src/services/heldMail.js';

describe('heldMailJobSql', () => {
  it('is one parenthesised condition, so an OR beside it cannot widen it', () => {
    const sql = heldMailJobSql('j').replace(/\s+/g, ' ');
    expect(sql).toBe(
      "(j.status = 'pending' AND j.provider_outcome = 'not_dispatched' AND j.attempts = 0 " +
        'AND j.mail_hold_until IS NOT NULL AND j.next_attempt_at > NOW())'
    );
  });

  it('takes a plain table alias only', () => {
    for (const alias of ['j', 'letter_jobs', 'held_job']) expect(() => heldMailJobSql(alias)).not.toThrow();
    for (const alias of ['', 'j.status', 'j; DROP TABLE x', 'J', 'j1']) expect(() => heldMailJobSql(alias), alias).toThrow();
  });
});

describe('isHeldMailJobState', () => {
  const NOW = Date.parse('2026-10-12T12:00:00Z');
  const held = {
    status: 'pending',
    providerOutcome: 'not_dispatched',
    attempts: 0,
    mailHoldUntil: new Date('2026-10-20T13:00:00Z'),
    nextAttemptAt: new Date('2026-10-20T13:00:00Z')
  };

  it('is held mail while pending, not dispatched, never attempted, with a hold and not yet due', () => {
    expect(isHeldMailJobState(held, NOW)).toBe(true);
  });

  it.each([
    ['taken by the run', { status: 'processing' }],
    ['dispatched', { providerOutcome: 'accepted' }],
    ['tried once', { attempts: 1 }],
    ['created without a hold', { mailHoldUntil: null }],
    ['with no attempt time', { nextAttemptAt: null }],
    ['due now', { nextAttemptAt: new Date(NOW) }],
    // An operator's release moves only the attempt time: the hold it ended stays on the job.
    ['released early', { nextAttemptAt: new Date(NOW - 1000) }]
  ])('is not held mail when %s', (_label, change) => {
    expect(isHeldMailJobState({ ...held, ...change }, NOW)).toBe(false);
  });
});
