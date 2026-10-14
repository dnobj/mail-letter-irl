/**
 * Runs a signature's pixel work off the main thread (#730): one job, from
 * workerData, answered once, then the thread ends. Started per picture by
 * runSignatureAnalysis (signatureImage.ts); signatures are set rarely, so a
 * thread's start-up costs less than keeping one alive.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { analyseSignature } from './signatureAnalysis.js';

const { grey, width, height } = workerData as { grey: Uint8Array; width: number; height: number };
const result = analyseSignature(grey, width, height);
// The cleaned pixels move to the main thread rather than being copied.
parentPort?.postMessage(result, result.ok ? [result.cleaned.buffer as ArrayBuffer] : []);
