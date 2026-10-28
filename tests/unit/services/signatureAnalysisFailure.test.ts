/**
 * When a signature's analysis itself fails (a missing worker file, out of
 * memory, the timeout), the person is told to try another picture and the
 * operator is told it was not the picture, and how it failed (#730).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const analysis = vi.hoisted(() => ({ fail: true }));

vi.mock('../../../src/services/signatureAnalysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/signatureAnalysis.js')>();
  return {
    ...actual,
    analyseSignature: (...args: Parameters<typeof actual.analyseSignature>) => {
      if (analysis.fail) throw new Error('worker exited');
      return actual.analyseSignature(...args);
    },
  };
});

vi.mock('../../../src/utils/diagnosticLog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: vi.fn(),
}));

import { cleanSignatureImage, runSignatureAnalysis, SignatureAnalysisError } from '../../../src/services/signatureImage.js';
import { writeDiagnostic } from '../../../src/utils/diagnosticLog.js';

afterEach(() => {
  vi.mocked(writeDiagnostic).mockClear();
  analysis.fail = true;
});

const blankPaper = () =>
  sharp({ create: { width: 800, height: 300, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();

describe('a signature analysis that fails', () => {
  it('refuses the picture as unprocessable, and logs that the analysis failed and how', async () => {
    await expect(cleanSignatureImage(await blankPaper())).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(writeDiagnostic).toHaveBeenCalledTimes(1);
    expect(writeDiagnostic).toHaveBeenCalledWith('error', 'signature.analysis_failed', {
      errorClass: 'unknown_error',
      failure: 'in_thread',
    });
  });

  it('logs nothing for a picture the analysis refuses', async () => {
    analysis.fail = false;
    await expect(cleanSignatureImage(await blankPaper())).rejects.toMatchObject({ code: 'NO_SIGNATURE_FOUND' });
    expect(writeDiagnostic).not.toHaveBeenCalled();
  });

  it('names a worker that cannot start, as a missing worker file is', async () => {
    // Run from source, there is no compiled worker beside this file to start.
    const failure = await runSignatureAnalysis(new Uint8Array(400 * 200).fill(240), 400, 200, true).catch((error) => error);
    expect(failure).toBeInstanceOf(SignatureAnalysisError);
    expect(failure).toMatchObject({ failure: 'worker_error' });
  });
});
