/**
 * A signature analysis whose worker cannot even be made (Node refuses to
 * start a thread) fails the way one that starts and throws does, so the
 * operator's log names it (#730).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:worker_threads', () => ({
  Worker: class {
    constructor() {
      throw new Error('no thread for you');
    }
  },
}));

import { runSignatureAnalysis, SignatureAnalysisError } from '../../../src/services/signatureImage.js';

describe('a signature analysis worker that cannot be made', () => {
  it('fails as a worker error', async () => {
    const failure = await runSignatureAnalysis(new Uint8Array(400 * 200).fill(240), 400, 200, true).catch((error) => error);
    expect(failure).toBeInstanceOf(SignatureAnalysisError);
    expect(failure).toMatchObject({ failure: 'worker_error' });
  });
});
