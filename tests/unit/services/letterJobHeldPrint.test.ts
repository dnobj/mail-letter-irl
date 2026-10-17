/**
 * The outbox's side of held mail's print (#697): the stored PDF read before
 * the dispatch marker and handed to the provider with the fingerprint the
 * send recorded, only when the row as marked still records those bytes; and
 * the PDF deleted once the provider has accepted the mail.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  transaction: vi.fn(),
  sendLetter: vi.fn(),
  sendPostcard: vi.fn(),
  storedHeldPdf: vi.fn(),
  forgetHeldPdf: vi.fn()
}));
const { query, clientQuery, sendLetter, sendPostcard, storedHeldPdf, forgetHeldPdf } = mocks;

vi.mock('../../../src/services/operatorNotify.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/operatorNotify.js')>()),
  reportToOperator: vi.fn(async () => 'sent')
}));
vi.mock('../../../src/db/index.js', () => ({ query: mocks.query, transaction: mocks.transaction }));
vi.mock('../../../src/services/providers/index.js', () => ({
  getProviderForMailType: vi.fn(async () => ({
    config: { name: 'postgrid', displayName: 'PostGrid' },
    printsRenderedPdf: true,
    sendLetter: mocks.sendLetter,
    sendPostcard: mocks.sendPostcard
  }))
}));
vi.mock('../../../src/services/heldPrintPdf.js', () => ({
  storedHeldPdf: mocks.storedHeldPdf,
  forgetHeldPdf: mocks.forgetHeldPdf
}));

import { processLetterJob } from '../../../src/services/letterJobService.js';

const SHA = 'a'.repeat(64);
const FINGERPRINT = `fp1:${'b'.repeat(64)}`;
const PDF = Buffer.from('%PDF- stored');

const job = {
  job_id: 'job-1',
  letter_id: 'letter-1',
  status: 'processing',
  provider_outcome: 'not_dispatched',
  attempts: 1,
  max_attempts: 5,
  idempotency_key: 'letter-1',
  next_attempt_at: new Date(),
  scheduled_at: new Date(),
  created_at: new Date(),
  updated_at: new Date()
};

const baseLetter = {
  letter_id: 'letter-1',
  user_id: 'user-1',
  content: {
    bodyText: 'Hello',
    signOff: 'Regards',
    sender: { name: 'Sender', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    layoutType: 'text_only',
    rendererVersion: 'pdf-1'
  },
  recipient: { name: 'Recipient', addressLine1: '2 Main St', city: 'Dallas', state: 'TX', postalCode: '75201', country: 'US' },
  credits_cost: 2,
  status: 'queued',
  mail_type: 'letter',
  mail_on: '2026-11-02',
  print_pdf_sha256: SHA,
  print_layout_fingerprint: FINGERPRINT,
  print_layout_engine: 'layout-1'
};

/** The suite's database: `preview` is the row read before the marker, `marked` the row as marked. */
function rows(preview: Record<string, unknown>, marked: Record<string, unknown> = preview) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('WITH candidate')) return { rows: [{ ...job }] };
    if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...preview }] };
    return { rows: [] };
  });
  let providerDispatched = false;
  clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT jobs.letter_id')) return { rows: [{ letter_id: 'letter-1', funding_order_id: null }] };
    if (sql.includes("SET provider_outcome = 'dispatching'")) providerDispatched = true;
    if (sql.startsWith('SELECT status, funding_order_id FROM letters')) {
      return { rows: [{ status: providerDispatched ? 'processing' : 'queued', funding_order_id: null }] };
    }
    if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...marked }] };
    if (sql.startsWith('SELECT * FROM letter_jobs')) {
      return { rows: [{ ...job, provider_outcome: providerDispatched ? 'dispatching' : 'not_dispatched' }] };
    }
    return { rows: [] };
  });
}

describe("held mail's print in the outbox (#697)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
      callback({ query: clientQuery })
    );
    sendLetter.mockResolvedValue({ success: true, trackingId: 'provider-1', costCents: 100 });
    sendPostcard.mockResolvedValue({ success: true, trackingId: 'provider-2', costCents: 100 });
    storedHeldPdf.mockResolvedValue(PDF);
    forgetHeldPdf.mockResolvedValue(undefined);
  });

  it('hands the provider the stored PDF and the recorded fingerprint, then deletes the PDF once accepted', async () => {
    rows(baseLetter);
    const result = await processLetterJob('job-1', {});
    expect(result.completed).toBe(true);
    expect(storedHeldPdf).toHaveBeenCalledWith(expect.objectContaining({ letter_id: 'letter-1', print_pdf_sha256: SHA }));
    expect(sendLetter).toHaveBeenCalledWith(expect.objectContaining({ heldPrint: { pdf: PDF, layoutFingerprint: FINGERPRINT } }));
    expect(forgetHeldPdf).toHaveBeenCalledWith('letter-1');
    // Read before the dispatch marker: a store that is down never fails a dispatch.
    const markedAt = clientQuery.mock.invocationCallOrder[
      clientQuery.mock.calls.findIndex(call => String(call[0]).includes("SET provider_outcome = 'dispatching'"))
    ];
    expect(storedHeldPdf.mock.invocationCallOrder[0]).toBeLessThan(markedAt);
  });

  it('hands a postcard its stored PDF too', async () => {
    rows({ ...baseLetter, mail_type: 'postcard', content: { message: 'Hi', frontImageData: 'data:image/png;base64,', rendererVersion: 'pdf-1' } });
    await processLetterJob('job-1', {});
    expect(sendPostcard).toHaveBeenCalledWith(expect.objectContaining({ heldPrint: { pdf: PDF, layoutFingerprint: FINGERPRINT } }));
  });

  it('hands only the fingerprint when no PDF could be read', async () => {
    storedHeldPdf.mockResolvedValue(undefined);
    rows(baseLetter);
    await processLetterJob('job-1', {});
    expect(sendLetter).toHaveBeenCalledWith(expect.objectContaining({ heldPrint: { layoutFingerprint: FINGERPRINT } }));
  });

  it('drops the PDF when the row as marked records other bytes than the one read', async () => {
    rows(baseLetter, { ...baseLetter, print_pdf_sha256: 'c'.repeat(64) });
    await processLetterJob('job-1', {});
    expect(sendLetter).toHaveBeenCalledWith(expect.objectContaining({ heldPrint: { layoutFingerprint: FINGERPRINT } }));
  });

  it('hands nothing for mail the send recorded nothing of, and deletes nothing for mail not held', async () => {
    storedHeldPdf.mockResolvedValue(undefined);
    const plain = { ...baseLetter, mail_on: null, print_pdf_sha256: null, print_layout_fingerprint: null, print_layout_engine: null };
    rows(plain);
    await processLetterJob('job-1', {});
    expect(sendLetter.mock.calls[0][0]).not.toHaveProperty('heldPrint');
    expect(forgetHeldPdf).not.toHaveBeenCalled();
  });

  it('asks the bucket nothing after acceptance for held mail that records no PDF', async () => {
    storedHeldPdf.mockResolvedValue(undefined);
    rows({ ...baseLetter, print_pdf_sha256: null });
    await expect(processLetterJob('job-1', {})).resolves.toMatchObject({ completed: true });
    expect(forgetHeldPdf).not.toHaveBeenCalled();
  });

  it('keeps the PDF when the provider did not accept the mail', async () => {
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'HTTP 503',
      metadata: { statusCode: 503, retryable: true, submissionOutcome: 'ambiguous' }
    });
    rows(baseLetter);
    await processLetterJob('job-1', {});
    expect(forgetHeldPdf).not.toHaveBeenCalled();
  });
});
