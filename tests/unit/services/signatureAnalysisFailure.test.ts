/**
 * When a signature's analysis itself fails (a missing worker file, out of
 * memory, the timeout), the person is told to try another picture and the
 * operator is told it was not the picture (#730).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('../../../src/services/signatureAnalysis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/signatureAnalysis.js')>()),
  analyseSignature: () => {
    throw new Error('worker exited');
  },
}));

vi.mock('../../../src/utils/diagnosticLog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: vi.fn(),
}));

import { cleanSignatureImage } from '../../../src/services/signatureImage.js';
import { writeDiagnostic } from '../../../src/utils/diagnosticLog.js';

afterEach(() => vi.mocked(writeDiagnostic).mockClear());

describe('a signature analysis that fails', () => {
  it('refuses the picture as unprocessable, and logs that the analysis failed', async () => {
    const picture = await sharp({ create: { width: 800, height: 300, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();

    await expect(cleanSignatureImage(picture)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(writeDiagnostic).toHaveBeenCalledWith(
      'error',
      'signature.analysis_failed',
      expect.objectContaining({ errorClass: expect.any(String) })
    );
  });
});
