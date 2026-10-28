/**
 * A signature's picture, cleaned for print (#608, concept 3).
 *
 * A person photographs their signature: ink on paper, often grey, with a
 * shadow across it or a desk at the edges, sometimes turned by the phone, and
 * sometimes a stray mark beside it. What prints must be dark ink on white,
 * cropped to the signature, so the letter shows a signature and not a
 * photograph of paper. The steps:
 *
 * 1. Turn the picture upright by its EXIF orientation, put any transparency
 *    on white, and make it grey, no larger than 1600 px on its longest edge.
 * 2. Estimate the paper's light at every point with a grey-level closing: a
 *    maximum filter, then a minimum filter, over a window wider than any pen
 *    stroke. Thin dark strokes vanish into the paper around them, while a
 *    shadow, a desk or a grey sheet, being larger than the window, stays as
 *    it is, edges included (van Herk and Gil-Werman's filters, linear time).
 * 3. Divide each pixel by its paper. Paper comes out near 1 wherever the light
 *    fell; ink well under it. Map 0.40 and below to black and 0.75 and above
 *    to white.
 * 4. Find the ink's connected pieces. Keep the largest and every piece near
 *    it: a speck in a corner neither stretches the crop nor falls inside it,
 *    while an i's dot stays with its word.
 * 5. Crop to what was kept, with a small margin, and fit it inside 1200 x 400
 *    px as a grayscale PNG.
 *
 * Refused: a picture with too little ink (blank paper), one whose ink fills
 * more than a third of its own box (a photograph, not a
 * signature), and a picture or a signature too small to print well. Pixels
 * made here are opened with plain sharp: they are ours and already bounded;
 * the picture itself is opened by openImage, with the pixel ceiling, under
 * the decode gate.
 */

import { Worker } from 'node:worker_threads';
import sharp, { type OutputInfo } from 'sharp';
import { ImageProcessingError, openImage, readImageHeader, runImageDecode } from './imageService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { analyseSignature, SIGNATURE_CLEANING, type SignatureAnalysis } from './signatureAnalysis.js';

export { closing, rankFilter, SIGNATURE_CLEANING } from './signatureAnalysis.js';

/** The largest signature kept: wide and short, as signatures are. */
export const SIGNATURE_MAX_SIZE = { width: 1200, height: 400 } as const;

export type SignatureImageRefusal = 'NO_SIGNATURE_FOUND' | 'NOT_A_SIGNATURE' | 'SIGNATURE_TOO_SMALL';

/** A picture that is not a signature this can clean, in words the person can act on. */
export class SignatureImageError extends Error {
  constructor(readonly code: SignatureImageRefusal, message: string) {
    super(message);
    this.name = 'SignatureImageError';
  }
}

const NO_SIGNATURE_FOUND_MESSAGE =
  "We couldn't find a signature in that picture. Sign in dark ink on white or light paper, and photograph it flat, close up, in good light.";
const NOT_A_SIGNATURE_MESSAGE =
  'That looks like a photograph rather than a signature. Sign in dark ink on plain white paper, and photograph just the signature.';
const SIGNATURE_TOO_SMALL_MESSAGE =
  'That signature is too small to print well. Photograph it closer, so it fills most of the picture.';

const REFUSAL_MESSAGES: Readonly<Record<SignatureImageRefusal, string>> = {
  NO_SIGNATURE_FOUND: NO_SIGNATURE_FOUND_MESSAGE,
  NOT_A_SIGNATURE: NOT_A_SIGNATURE_MESSAGE,
  SIGNATURE_TOO_SMALL: SIGNATURE_TOO_SMALL_MESSAGE,
};

/**
 * The pixel work runs on a worker thread when this is the compiled server:
 * it takes a quarter of a second or so, which would hold every other request
 * (#730). Run from source (the tests, tsx) there is no compiled worker to
 * start, so it runs here, on the same function.
 */
const ANALYSE_OFF_THREAD = import.meta.url.endsWith('.js');
const ANALYSIS_WORKER = new URL('./signatureAnalysisWorker.js', import.meta.url);
/** A worker that has not answered by now is ended, and the picture refused as unprocessable. */
const ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * How an analysis failed, for the operator's log: a fixed word, never the
 * picture or an error's own text. 'out_of_memory' is a worker that ran out
 * of heap, 'worker_error' one that could not be made or start (a missing
 * worker file says this) or threw, 'exit' one that ended without answering
 * or erring, 'timeout' one that took too long, and 'in_thread' the analysis
 * run here, from source. The log says 'unknown' for anything else.
 */
export type SignatureAnalysisFailure = 'out_of_memory' | 'worker_error' | 'exit' | 'timeout' | 'in_thread';

/** Node says a worker ran out of heap with an 'error' before its 'exit'. */
function workerFailure(error: unknown): SignatureAnalysisFailure {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out_of_memory' : 'worker_error';
}

export class SignatureAnalysisError extends Error {
  constructor(readonly failure: SignatureAnalysisFailure, cause?: unknown) {
    super(`signature analysis failed: ${failure}`, { cause });
    this.name = 'SignatureAnalysisError';
  }
}

export function runSignatureAnalysis(
  grey: Uint8Array,
  width: number,
  height: number,
  offThread: boolean = ANALYSE_OFF_THREAD,
  timeoutMs: number = ANALYSIS_TIMEOUT_MS
): Promise<SignatureAnalysis> {
  if (!offThread) {
    try {
      return Promise.resolve(analyseSignature(grey, width, height));
    } catch (error) {
      return Promise.reject(new SignatureAnalysisError('in_thread', error));
    }
  }
  // A copy of its own: sharp's buffer may share memory that cannot be moved.
  const pixels = new Uint8Array(grey);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(ANALYSIS_WORKER, {
        workerData: { grey: pixels, width, height },
        transferList: [pixels.buffer],
      });
    } catch (error) {
      reject(new SignatureAnalysisError('worker_error', error));
      return;
    }
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new SignatureAnalysisError('timeout'))), timeoutMs);
    worker.once('message', (result: SignatureAnalysis) => finish(() => resolve(result)));
    worker.once('error', (error) => finish(() => reject(new SignatureAnalysisError(workerFailure(error), error))));
    worker.once('exit', (code) => finish(() => reject(new SignatureAnalysisError('exit', new Error(`exit code ${code}`)))));
  });
}

export interface CleanedSignature {
  /** A grayscale PNG: dark ink on white, cropped to the signature. */
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Cleans a picture of a signature for print, under the decode gate. Throws
 * SignatureImageError for a picture that holds no signature it can use, and
 * ImageProcessingError for one it cannot open.
 */
export function cleanSignatureImage(input: Buffer, actorId?: string): Promise<CleanedSignature> {
  return runImageDecode(() => cleanSignature(input), actorId);
}

async function cleanSignature(input: Buffer): Promise<CleanedSignature> {
  const header = await readImageHeader(input);
  const { longEdge, shortEdge } = SIGNATURE_CLEANING.minSource;
  if (Math.max(header.width, header.height) < longEdge || Math.min(header.width, header.height) < shortEdge) {
    throw new SignatureImageError('SIGNATURE_TOO_SMALL', SIGNATURE_TOO_SMALL_MESSAGE);
  }

  const edge = SIGNATURE_CLEANING.analysisEdge;
  let grey: { data: Buffer; info: OutputInfo };
  try {
    grey = await openImage(input)
      .rotate()
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new ImageProcessingError(
      'PROCESSING_FAILED',
      'Image could not be processed. Please try a different image.',
      error instanceof Error ? error : undefined
    );
  }
  const { width, height, channels } = grey.info;
  if (channels !== 1) {
    throw new ImageProcessingError('PROCESSING_FAILED', 'Image could not be processed. Please try a different image.');
  }

  let analysis: SignatureAnalysis;
  try {
    analysis = await runSignatureAnalysis(grey.data, width, height);
  } catch (error) {
    // The person is told to try another picture; the operator is told that
    // the analysis itself failed, and how (a missing worker file, out of
    // memory, the timeout), which is not the picture's fault (#730).
    writeDiagnostic('error', 'signature.analysis_failed', {
      errorClass: classifyDiagnosticError(error, 'unknown_error'),
      failure: error instanceof SignatureAnalysisError ? error.failure : 'unknown',
    });
    throw new ImageProcessingError(
      'PROCESSING_FAILED',
      'Image could not be processed. Please try a different image.',
      error instanceof Error ? error : undefined
    );
  }
  if (!analysis.ok) throw new SignatureImageError(analysis.refusal, REFUSAL_MESSAGES[analysis.refusal]);
  const { cleaned, left, top, width: boxWidth, height: boxHeight } = analysis;

  const out = await sharp(cleaned, { raw: { width, height, channels: 1 } })
    .extract({ left, top, width: boxWidth, height: boxHeight })
    .resize({
      width: SIGNATURE_MAX_SIZE.width,
      height: SIGNATURE_MAX_SIZE.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    // One grey channel: sharp writes sRGB unless told otherwise, three times the bytes.
    .toColourspace('b-w')
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { png: out.data, width: out.info.width, height: out.info.height };
}
