/**
 * A signature's pixel work runs on a worker thread in the compiled server
 * (#730), so the quarter of a second it takes does not hold other requests.
 * The worker is the compiled one: `npm run verify` and CI build before the
 * unit tests. Without a build there is nothing to start, so this skips, except
 * in CI, where a missing build is a failure rather than a silent pass.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyseSignature } from '../../../src/services/signatureAnalysis.js';

const compiled = new URL('../../../dist/services/signatureImage.js', import.meta.url);
const built = existsSync(fileURLToPath(new URL('../../../dist/services/signatureAnalysisWorker.js', import.meta.url)));

/** Paper with a band of strokes across it: enough ink to keep, at the largest size analysed. */
function page(width: number, height: number): Uint8Array {
  const grey = new Uint8Array(width * height).fill(232);
  for (let y = 420; y < 560; y += 1) {
    for (let x = 300; x < 1300; x += 1) {
      if ((x + y) % 23 < 3) grey[y * width + x] = 40;
    }
  }
  return grey;
}

it.runIf(Boolean(process.env.CI))('finds the compiled worker in CI', () => {
  expect(built).toBe(true);
});

describe.skipIf(!built)('the signature analysis on a worker thread (#730)', () => {
  it('answers as the analysis does in-process, and leaves the event loop free while it works', async () => {
    const { runSignatureAnalysis } = (await import(compiled.href)) as typeof import('../../../src/services/signatureImage.js');
    const width = 1600;
    const height = 1000;
    const grey = page(width, height);
    const expected = analyseSignature(new Uint8Array(grey), width, height);

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      // No fourth argument: the compiled server's own default.
      const answer = await runSignatureAnalysis(grey, width, height);
      expect(answer).toEqual(expected);
    } finally {
      clearInterval(timer);
    }
    // In-process, nothing else runs until the analysis returns.
    expect(ticks).toBeGreaterThan(3);
    // The caller's pixels are its own still: the worker was given a copy.
    expect(grey.byteLength).toBe(width * height);
  }, 30_000);

  it('refuses a picture as the analysis does', async () => {
    const { runSignatureAnalysis } = (await import(compiled.href)) as typeof import('../../../src/services/signatureImage.js');
    const blank = new Uint8Array(400 * 200).fill(240);
    await expect(runSignatureAnalysis(blank, 400, 200, true)).resolves.toEqual({ ok: false, refusal: 'NO_SIGNATURE_FOUND' });
  }, 30_000);

  it('ends a worker that takes too long, and says it timed out', async () => {
    const { runSignatureAnalysis } = (await import(compiled.href)) as typeof import('../../../src/services/signatureImage.js');
    const width = 1600;
    const height = 1000;
    await expect(runSignatureAnalysis(page(width, height), width, height, true, 1)).rejects.toMatchObject({
      name: 'SignatureAnalysisError',
      failure: 'timeout',
    });
  }, 30_000);
});
