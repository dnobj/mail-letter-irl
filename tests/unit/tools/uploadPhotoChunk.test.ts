/**
 * upload_photo_chunk and its place in the tool list (#474, phase 3).
 *
 * The upload card's way to send a photo in an app with no file store. Off
 * unless its switch is on: then it is not listed, and a call is refused.
 * Card-only in every app, gated on the drafting scope, and the photo is
 * always the caller's own. upload_image tells its card whether the card may
 * send the photo itself.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

vi.mock('../../../src/services/photoUploadService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/photoUploadService.js')>()),
  receivePhotoChunk: vi.fn(async (_userId: string, input: { uploadId: string; total: number }) => ({
    uploadId: input.uploadId,
    received: input.total,
    total: input.total,
    done: true,
    width: 2400,
    height: 1600
  }))
}));

import { PhotoUploadRefusedError, receivePhotoChunk } from '../../../src/services/photoUploadService.js';
import { ImageProcessingError } from '../../../src/services/imageService.js';
import { uploadPhotoChunkTool } from '../../../src/tools/uploadPhotoChunk.js';
import { uploadImageTool } from '../../../src/tools/uploadImage.js';
import { describeTool, LetterIrlServer } from '../../../src/server.js';
import { APP_ONLY_TOOLS, buildToolMeta, summarizeToolResult } from '../../../src/mcp/registerTools.js';
import { clientProfileNamed } from '../../../src/auth/clientProfiles.js';
import { getRequiredToolScopes } from '../../../src/auth/toolScopes.js';

const ID = '7b0e3f2a-9c1d-4e5f-8a6b-1c2d3e4f5a6b';

const context = (userId = 'auth0|owner'): ToolContext =>
  ({
    user: { userId, creditsRemaining: 0, orders: [] },
    correlationId: 'test-correlation-id',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    now: () => new Date('2026-09-27T18:00:00Z'),
    persist: vi.fn()
  }) as unknown as ToolContext;

const chunk = { uploadId: ID, index: 0, total: 1, data: 'QUJD', context: 'postcard' };

describe('upload_photo_chunk (#474)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(receivePhotoChunk).mockClear();
  });

  it('refuses a call while its switch is off, before touching anything', async () => {
    await expect(uploadPhotoChunkTool.handler(chunk, context())).rejects.toThrow(
      'Photo upload is not available here yet. Use a link to the photo instead.'
    );
    expect(receivePhotoChunk).not.toHaveBeenCalled();
  });

  it('hands the chunk on for the calling account, and says what it received', async () => {
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    const ctx = context('auth0|caller');
    await expect(uploadPhotoChunkTool.handler(chunk, ctx)).resolves.toMatchObject({ done: true, uploadId: ID });
    expect(receivePhotoChunk).toHaveBeenCalledWith('auth0|caller', chunk);
    // The log carries sizes, never the photo.
    const logged = vi.mocked(ctx.logger.info).mock.calls[0][0] as Record<string, unknown>;
    expect(logged).toMatchObject({ event: 'photo_upload.finished', chunkIndex: 0, chunkTotal: 1, chunkChars: 4 });
    expect(JSON.stringify(logged)).not.toContain('QUJD');
  });

  it('lets out only words written for the person, since the card shows them as they are', async () => {
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    const refused = new PhotoUploadRefusedError('DAILY_LIMIT', 'This account has uploaded as many photos as it can today.');
    vi.mocked(receivePhotoChunk).mockRejectedValueOnce(refused);
    await expect(uploadPhotoChunkTool.handler(chunk, context())).rejects.toBe(refused);

    const unreadable = new ImageProcessingError('UNSUPPORTED_FORMAT', 'Unsupported image format. Please use PNG, JPEG, or WebP.');
    vi.mocked(receivePhotoChunk).mockRejectedValueOnce(unreadable);
    await expect(uploadPhotoChunkTool.handler(chunk, context())).rejects.toBe(unreadable);

    // Anything else, such as the store failing, becomes one plain sentence,
    // and the log names its class, not its text.
    vi.mocked(receivePhotoChunk).mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND bucket.internal'), { code: 'ENOTFOUND' })
    );
    const ctx = context();
    await expect(uploadPhotoChunkTool.handler(chunk, ctx)).rejects.toThrow(
      'The photo could not be kept just now. Please try again.'
    );
    const logged = vi.mocked(ctx.logger.error).mock.calls[0][0] as Record<string, unknown>;
    expect(logged).toMatchObject({ event: 'photo_upload.failed' });
    expect(JSON.stringify(logged)).not.toContain('bucket.internal');
  });

  it('is listed only while its switch is on', () => {
    const names = () => new LetterIrlServer().listTools().map((tool) => tool.name);
    expect(names()).not.toContain('upload_photo_chunk');
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    expect(names()).toContain('upload_photo_chunk');
  });

  it('is hidden from the model in every app, asks for no person, and needs the drafting scope', () => {
    expect(APP_ONLY_TOOLS.has('upload_photo_chunk')).toBe(true);
    for (const sendRule of [false, true]) {
      const meta = buildToolMeta('upload_photo_chunk', {}, true, sendRule);
      expect(meta['openai/visibility']).toBe('private');
      expect((meta.ui as Record<string, unknown>).visibility).toEqual(['app']);
      expect(meta['anthropic/requiresUserInteraction']).toBeUndefined();
    }
    expect(getRequiredToolScopes('upload_photo_chunk')).toEqual(['mail:draft']);
  });
});

describe('upload_image tells its card whether it may send the photo itself (#474)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("tells Claude's model to call the preview with no image, since the card leaves no imageUrl", () => {
    const claude = clientProfileNamed('claude');
    const chatgpt = clientProfileNamed('chatgpt');
    const noImage = 'call the preview tool with no image and no imageUrl';
    const output = { status: 'awaiting_upload', message: 'Select a photo for your postcard.', cardUploadAvailable: true };

    // Off: every app reads what it always has.
    expect(describeTool(uploadImageTool, claude)).toContain('returns an imageUrl to use in the next preview call');
    expect(summarizeToolResult('upload_image', { ...output, cardUploadAvailable: false }, claude)).toBe(
      'Select a photo for your postcard.'
    );

    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    expect(describeTool(uploadImageTool, claude)).toContain(noImage);
    expect(describeTool(uploadImageTool, claude)).not.toContain('returns an imageUrl');
    expect(summarizeToolResult('upload_image', output, claude)).toContain(noImage);
    // ChatGPT's card hands on a link, as before.
    expect(describeTool(uploadImageTool, chatgpt)).toContain('returns an imageUrl to use in the next preview call');
    expect(summarizeToolResult('upload_image', output, chatgpt)).toBe('Select a photo for your postcard.');
  });

  it('says no while the switch is off, and yes once it is on', async () => {
    await expect(uploadImageTool.handler({ context: 'postcard' }, context())).resolves.toMatchObject({
      cardUploadAvailable: false
    });
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    await expect(uploadImageTool.handler({ context: 'postcard' }, context())).resolves.toMatchObject({
      cardUploadAvailable: true
    });
  });
});
