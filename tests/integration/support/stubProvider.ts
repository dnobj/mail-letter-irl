/**
 * Controllable mail provider for integration tests.
 *
 * Registers a real provider through the production registry and routes mail to
 * it via the same lookup the application uses, rather than mocking the module.
 * That means tests exercise the genuine outbox path - claim, dispatch, classify
 * the outcome, transition the job - instead of a stand-in for it.
 *
 * Why this exists: issue #151 returns a customer's Letter Pack when a send
 * terminally fails, and the money logic can be unit-tested, but "the terminal
 * path actually calls it" cannot. Nothing in this repository stubbed a provider,
 * so that wiring had no coverage at all.
 *
 * Usage:
 *
 *   installStubProvider();                       // before importing services
 *   stubProvider.nextResult = definiteRejection('card refused');
 *   await processLetterJob(jobId);
 *
 * The provider registry caches by name, so the same instance is reused for the
 * life of the process. Behaviour is changed by mutating `stubProvider`, not by
 * re-registering.
 */
// Deliberately NO static import of the provider registry. That module pulls in
// src/db, which builds its pool from DATABASE_URL at load time - importing it
// here would fix the pool to the wrong database before a test's beforeAll has
// pointed DATABASE_URL at its disposable schema. The registry is imported
// dynamically inside installStubProvider instead.
import type {
  LetterFulfillmentProvider,
  LetterParams,
  LetterResult,
  PostcardParams,
  PostcardResult
} from '../../../src/services/providers/types.js';

export const STUB_PROVIDER_NAME = 'test-stub';

type AnyResult = LetterResult | PostcardResult;

export interface StubProvider {
  /** Result the next send returns. Consumed once, then falls back to `defaultResult`. */
  nextResult?: AnyResult;
  /** Result used when `nextResult` is unset. Defaults to a definite rejection. */
  defaultResult: AnyResult;
  /** Throw instead of returning. Models a transport failure, which the outbox treats as ambiguous. */
  throwOnSend?: Error;
  /** Every send the outbox made, in order. */
  calls: { mailType: 'letter' | 'postcard'; params: LetterParams | PostcardParams }[];
  /** Invoked before each send. Use to interleave a concurrent action mid-dispatch. */
  onSend?: () => Promise<void> | void;
}

/** A provider result that proves the piece was refused and no mail exists. */
export function definiteRejection(error = 'Stub rejection'): LetterResult {
  return {
    success: false,
    trackingId: '',
    error,
    metadata: { retryable: false, submissionOutcome: 'definite_rejection' }
  } as LetterResult;
}

/** A result the outbox must treat as ambiguous - the piece may have been mailed. */
export function ambiguousFailure(error = 'Stub timeout'): LetterResult {
  return {
    success: false,
    trackingId: '',
    error,
    metadata: { retryable: false, submissionOutcome: 'ambiguous' }
  } as LetterResult;
}

/** A successful send. */
export function providerSuccess(trackingId = 'stub-tracking'): LetterResult {
  return {
    success: true,
    trackingId,
    metadata: { submissionOutcome: 'accepted' }
  } as LetterResult;
}

export const stubProvider: StubProvider = {
  defaultResult: definiteRejection(),
  calls: []
};

/** Clear recorded calls and queued behaviour between tests. */
export function resetStubProvider(): void {
  stubProvider.nextResult = undefined;
  stubProvider.throwOnSend = undefined;
  stubProvider.onSend = undefined;
  stubProvider.defaultResult = definiteRejection();
  stubProvider.calls = [];
}

function take(): AnyResult {
  const queued = stubProvider.nextResult;
  stubProvider.nextResult = undefined;
  return queued ?? stubProvider.defaultResult;
}

/**
 * Register the stub and route all mail to it.
 *
 * Routing resolves from the provider_routing table first and falls back to
 * LETTER_PROVIDER, so setting the environment variable is enough for a schema
 * with no routing rows - which is every disposable test schema.
 *
 * Call before importing the services under test: the registry is module state,
 * and letterJobService resolves the provider per dispatch, so ordering only
 * matters for the registration itself.
 */
export async function installStubProvider(): Promise<void> {
  const instance: LetterFulfillmentProvider = {
    name: STUB_PROVIDER_NAME,
    async sendLetter(params: LetterParams): Promise<LetterResult> {
      stubProvider.calls.push({ mailType: 'letter', params });
      await stubProvider.onSend?.();
      if (stubProvider.throwOnSend) throw stubProvider.throwOnSend;
      return take() as LetterResult;
    },
    async sendPostcard(params: PostcardParams): Promise<PostcardResult> {
      stubProvider.calls.push({ mailType: 'postcard', params });
      await stubProvider.onSend?.();
      if (stubProvider.throwOnSend) throw stubProvider.throwOnSend;
      return take() as PostcardResult;
    }
  } as LetterFulfillmentProvider;

  const { registerProvider } = await import('../../../src/services/providers/index.js');
  registerProvider(STUB_PROVIDER_NAME, () => instance);
  process.env.LETTER_PROVIDER = STUB_PROVIDER_NAME;
}
