/**
 * The signature tools (#608): set_signature saves one from a picture,
 * get_signature says whether one is saved, clear_signature removes it. The
 * picture's cleaning is tested in signatureImage.test.ts and the statements
 * against PostgreSQL in signatures.postgres.test.ts; here both are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/signatureService.js', () => ({
  getSignature: vi.fn(),
  saveSignature: vi.fn(),
  clearSignature: vi.fn()
}));
vi.mock('../../../src/services/imageService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  downloadSignatureSource: vi.fn()
}));
vi.mock('../../../src/services/signatureImage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/signatureImage.js')>()),
  cleanSignatureImage: vi.fn()
}));

import { AccountErasedError } from '../../../src/auth/accountErased.js';
import { clearSignature, getSignature, saveSignature } from '../../../src/services/signatureService.js';
import { downloadSignatureSource, ImageProcessingError } from '../../../src/services/imageService.js';
import { cleanSignatureImage, SignatureImageError } from '../../../src/services/signatureImage.js';
import { setSignatureTool } from '../../../src/tools/setSignature.js';
import { getSignatureTool } from '../../../src/tools/getSignature.js';
import { clearSignatureTool } from '../../../src/tools/clearSignature.js';
import { SignatureRefusedError, signatureImageUri, signatureSourceOf } from '../../../src/tools/signatureShared.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const USER = 'auth0|signer';
const PICTURE = Buffer.from('a photo of a signature');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CLEANED = { png: PNG, width: 300, height: 90 };
const SAVED = {
  width: 300,
  height: 90,
  useByDefault: true,
  createdAt: '2026-10-02T14:00:00.000Z',
  updatedAt: '2026-10-03T09:30:00.000Z'
};
const FILE = { download_url: 'https://files.example.invalid/sig.jpg', file_id: 'file-1', mime_type: 'image/jpeg' };

let logger: { info: ReturnType<typeof vi.fn> };

function context(): ToolContext {
  logger = { info: vi.fn() };
  return {
    user: { userId: USER } as unknown as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { ...logger, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-03T09:30:00Z'),
    persist: vi.fn()
  };
}

function offered() {
  vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
}

beforeEach(() => {
  vi.mocked(getSignature).mockReset();
  vi.mocked(saveSignature).mockReset();
  vi.mocked(clearSignature).mockReset();
  vi.mocked(downloadSignatureSource).mockReset();
  vi.mocked(cleanSignatureImage).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('while signatures are not offered', () => {
  it.each([
    ['the flag off', { LETTER_IRL_SIGNATURES_ENABLED: '', LETTER_IRL_PRINT_RENDERER: 'pdf' }],
    ['the flag on, with the legacy renderer', { LETTER_IRL_SIGNATURES_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' }]
  ])('every tool refuses, with %s, and touches nothing', async (_name, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    for (const call of [
      () => setSignatureTool.handler({ imageUrl: 'https://example.invalid/sig.png' }, context()),
      () => getSignatureTool.handler({}, context()),
      () => clearSignatureTool.handler({ confirm: true }, context())
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'SIGNATURES_OFF', diagnosticClass: 'SIGNATURES_OFF' });
    }
    expect(downloadSignatureSource).not.toHaveBeenCalled();
    expect(getSignature).not.toHaveBeenCalled();
    expect(clearSignature).not.toHaveBeenCalled();
  });
});

describe('set_signature', () => {
  beforeEach(() => {
    offered();
    vi.mocked(downloadSignatureSource).mockResolvedValue(PICTURE);
    vi.mocked(cleanSignatureImage).mockResolvedValue(CLEANED);
    vi.mocked(saveSignature).mockResolvedValue({ ok: true, replaced: false, signature: SAVED });
  });

  it('saves the cleaned picture from a link, and gives the card the picture, not the model', async () => {
    const output = await setSignatureTool.handler({ imageUrl: ' https://example.invalid/sig.png ' }, context());
    expect(downloadSignatureSource).toHaveBeenCalledWith('https://example.invalid/sig.png', { actorId: USER });
    expect(cleanSignatureImage).toHaveBeenCalledWith(PICTURE, USER);
    expect(saveSignature).toHaveBeenCalledWith(USER, CLEANED);
    expect(output).toEqual({
      saved: true,
      replaced: false,
      width: 300,
      height: 90,
      signatureImage: `data:image/png;base64,${PNG.toString('base64')}`,
      message:
        'Saved the signature. Letters previewed from now on print it under the closing. ' +
        'Letters already previewed keep what they had. clear_signature removes it.'
    });
    // The log names the size, never the picture or where it came from.
    expect(logger.info).toHaveBeenCalledWith(
      { correlationId: 'corr-1', event: 'signature.saved', replaced: false, width: 300, height: 90 },
      'Signature saved'
    );
  });

  it('prefers a file the person attached to a link, and says when it replaced one', async () => {
    vi.mocked(saveSignature).mockResolvedValue({ ok: true, replaced: true, signature: SAVED });
    const output = await setSignatureTool.handler({ image: FILE, imageUrl: 'https://example.invalid/other.png' }, context());
    expect(downloadSignatureSource).toHaveBeenCalledWith(FILE.download_url, { actorId: USER });
    expect(output.replaced).toBe(true);
    expect(output.message.startsWith('Saved the new signature, in place of the one before.')).toBe(true);
  });

  it('asks for a picture when the call names none', async () => {
    for (const input of [{}, { imageUrl: '   ' }]) {
      await expect(setSignatureTool.handler(input, context())).rejects.toMatchObject({ code: 'SIGNATURE_PICTURE_REQUIRED' });
    }
    expect(downloadSignatureSource).not.toHaveBeenCalled();
  });

  it('says a file that did not come through, rather than that none was given', async () => {
    // ChatGPT on a phone can send a file id with nothing to download, or a bare reference.
    for (const unresolved of [{ file_id: 'file-2', download_url: '' }, 'sediment://file-2']) {
      await expect(setSignatureTool.handler({ image: unresolved as never }, context())).rejects.toMatchObject({
        code: 'SIGNATURE_PICTURE_UNREADABLE'
      });
    }
    expect(downloadSignatureSource).not.toHaveBeenCalled();
  });

  it.each([
    ['NO_SIGNATURE_FOUND', 'none found'],
    ['NOT_A_SIGNATURE', 'a photograph'],
    ['SIGNATURE_TOO_SMALL', 'too small']
  ] as const)("passes on the cleaning's %s refusal in its words, and saves nothing", async (code, words) => {
    vi.mocked(cleanSignatureImage).mockRejectedValue(new SignatureImageError(code, words));
    const error = await setSignatureTool.handler({ imageUrl: 'https://example.invalid/sig.png' }, context()).catch((e) => e);
    expect(error).toBeInstanceOf(SignatureRefusedError);
    expect(error).toMatchObject({ code, diagnosticClass: code, message: words });
    expect(saveSignature).not.toHaveBeenCalled();
  });

  it("lets a picture it cannot open fail with the image service's words", async () => {
    const unopenable = new ImageProcessingError('UNSUPPORTED_FORMAT', 'Unsupported image format. Please use PNG, JPEG, or WebP.');
    vi.mocked(cleanSignatureImage).mockRejectedValue(unopenable);
    await expect(setSignatureTool.handler({ imageUrl: 'https://example.invalid/sig.gif' }, context())).rejects.toBe(unopenable);
    expect(saveSignature).not.toHaveBeenCalled();
  });

  it('refuses an account erased while it waited', async () => {
    vi.mocked(saveSignature).mockResolvedValue({ ok: false, refusal: 'account_closed' });
    await expect(setSignatureTool.handler({ imageUrl: 'https://example.invalid/sig.png' }, context())).rejects.toBeInstanceOf(
      AccountErasedError
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('takes a file through ChatGPT, and is described as a destructive change of the saved one', () => {
    expect(setSignatureTool.meta).toMatchObject({ 'openai/fileParams': ['image'], destructiveHint: true });
    const description = typeof setSignatureTool.description === 'function' ? setSignatureTool.description({} as never) : setSignatureTool.description;
    expect(description).toContain("Use only the person's own signature.");
    expect(description).toContain('It is free and sends nothing.');
  });
});

describe('get_signature', () => {
  beforeEach(offered);

  it('gives the size and when it was saved to the model, and the picture to the card', async () => {
    vi.mocked(getSignature).mockResolvedValue({ ...SAVED, png: PNG });
    expect(await getSignatureTool.handler({}, context())).toEqual({
      saved: true,
      width: 300,
      height: 90,
      savedAt: SAVED.updatedAt,
      signatureImage: signatureImageUri(PNG),
      message: 'A signature is saved. Letters print it under the closing.'
    });
    expect(getSignature).toHaveBeenCalledWith(USER);
  });

  it('says none is saved, and how to save one', async () => {
    vi.mocked(getSignature).mockResolvedValue(null);
    expect(await getSignatureTool.handler({}, context())).toEqual({
      saved: false,
      message: "No signature is saved. set_signature saves one from a photo of the person's signature."
    });
  });
});

describe('clear_signature', () => {
  beforeEach(offered);

  it('removes the saved signature once confirmed', async () => {
    vi.mocked(clearSignature).mockResolvedValue(true);
    expect(await clearSignatureTool.handler({ confirm: true }, context())).toEqual({
      removed: true,
      message: 'Removed the saved signature. New letter previews print none; letters already previewed keep theirs.'
    });
    expect(clearSignature).toHaveBeenCalledWith(USER);
    expect(logger.info).toHaveBeenCalledWith(
      { correlationId: 'corr-1', event: 'signature.cleared', removed: true },
      'Signature cleared'
    );
  });

  it('says nothing changed when none was saved', async () => {
    vi.mocked(clearSignature).mockResolvedValue(false);
    expect(await clearSignatureTool.handler({ confirm: true }, context())).toEqual({
      removed: false,
      message: 'No signature was saved, so nothing changed.'
    });
  });

  it('removes nothing without confirm: true', async () => {
    await expect(clearSignatureTool.handler({ confirm: false }, context())).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(clearSignature).not.toHaveBeenCalled();
  });
});

describe('signatureSourceOf', () => {
  it('takes a usable file first, then a trimmed link, and otherwise nothing', () => {
    expect(signatureSourceOf({ image: FILE, imageUrl: 'https://example.invalid/b.png' })).toBe(FILE.download_url);
    expect(signatureSourceOf({ imageUrl: ' https://example.invalid/b.png ' })).toBe('https://example.invalid/b.png');
    expect(signatureSourceOf({})).toBeNull();
    expect(signatureSourceOf({ image: undefined, imageUrl: '' })).toBeNull();
  });
});
