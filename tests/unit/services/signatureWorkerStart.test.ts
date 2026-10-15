/**
 * Each way a signature analysis worker can fail is named for the operator's
 * log (#730): a worker that cannot be made, one that runs out of heap (Node
 * says so with an 'error' before its 'exit'), one that throws, one that ends
 * without answering. The worker here is a stand-in the test drives.
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => ({
  throwOnMake: false,
  made: [] as Array<{ emit: (event: string, value?: unknown) => boolean; terminate: () => Promise<number> }>,
}));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    Worker: class extends Emitter {
      terminate = vi.fn(async () => 1);
      constructor() {
        super();
        if (workers.throwOnMake) throw new Error('no thread for you');
        workers.made.push(this);
      }
    },
  };
});

import { runSignatureAnalysis, SignatureAnalysisError } from '../../../src/services/signatureImage.js';

const pixels = () => new Uint8Array(400 * 200).fill(240);

/** Starts an analysis on a stand-in worker and lets the test say what the worker does. */
function start() {
  const answer = runSignatureAnalysis(pixels(), 400, 200, true).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  const worker = workers.made[workers.made.length - 1] as unknown as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
  return { answer, worker };
}

beforeEach(() => {
  workers.throwOnMake = false;
  workers.made.length = 0;
});

describe('a signature analysis worker that fails', () => {
  it('names one that cannot be made', async () => {
    workers.throwOnMake = true;
    const failure = await runSignatureAnalysis(pixels(), 400, 200, true).catch((error) => error);
    expect(failure).toBeInstanceOf(SignatureAnalysisError);
    expect(failure).toMatchObject({ failure: 'worker_error' });
  });

  it('names one that ran out of heap, though its exit follows', async () => {
    const { answer, worker } = start();
    worker.emit('error', Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
    worker.emit('exit', 1);
    expect(await answer).toMatchObject({ error: { failure: 'out_of_memory' } });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('names one that threw', async () => {
    const { answer, worker } = start();
    worker.emit('error', Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' }));
    expect(await answer).toMatchObject({ error: { failure: 'worker_error' } });
  });

  it('names one that ended without answering', async () => {
    const { answer, worker } = start();
    worker.emit('exit', 0);
    expect(await answer).toMatchObject({ error: { failure: 'exit' } });
  });

  it('takes the answer, and nothing after it', async () => {
    const { answer, worker } = start();
    worker.emit('message', { ok: false, refusal: 'NO_SIGNATURE_FOUND' });
    worker.emit('exit', 0);
    worker.emit('error', new Error('late'));
    expect(await answer).toEqual({ value: { ok: false, refusal: 'NO_SIGNATURE_FOUND' } });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
