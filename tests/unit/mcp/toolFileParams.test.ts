import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { toolInputSchemas } from '../../../src/mcp/toolSchemas.js';
import { getZodInputShape } from '../../../src/mcp/registerTools.js';
import { UNRESOLVED_IMAGE_FILE_ID } from '../../../src/utils/imageFileParam.js';

/**
 * Issue #227. The Apps SDK file-param contract is enforced against the SERVED
 * JSON schema (what tools/list returns after zod conversion), and the
 * platform's tool scan silently strips any deviating property schema to {} -
 * disabling the file transform for the whole tool. ChatGPT's stored schema
 * for our image tools literally showed "image": {} because the old
 * union-with-string serialized to anyOf. These tests pin the contract at the
 * layer ChatGPT actually reads; the manifest snapshot test cannot see it.
 */

const IMAGE_TOOLS = [
  'quote_and_preview_letter_with_header_image',
  'quote_and_preview_letter_with_image',
  'quote_and_preview_postcard'
] as const;

function servedImageSchema(tool: (typeof IMAGE_TOOLS)[number]): Record<string, unknown> {
  const converted = zodToJsonSchema(toolInputSchemas[tool] as never) as {
    properties?: Record<string, Record<string, unknown>>;
  };
  return converted.properties?.image ?? {};
}

describe('SERVED file-param schemas via registerTools (the layer that mattered)', () => {
  // Round 2 of this bug: toolSchemas.ts is imported by registerTools for its
  // TYPES only - the schemas actually served to ChatGPT come from
  // zodSchemas.ts via zodInputSchemas/getZodInputShape, where the image param
  // was z.any() (serializing to {}). These pin the true serving path: the
  // SDK converts the shape returned by getZodInputShape.
  it.each(IMAGE_TOOLS)('%s serves the four-property file object through getZodInputShape', tool => {
    const shape = getZodInputShape(tool);
    expect(shape).toBeDefined();
    const converted = zodToJsonSchema(z.object(shape)) as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const image = converted.properties?.image ?? {};
    expect(image.type, `${tool} image must not serialize to {}`).toBe('object');
    expect(image.anyOf).toBeUndefined();
    expect(Object.keys((image.properties as Record<string, unknown>) ?? {}).sort()).toEqual([
      'download_url',
      'file_id',
      'file_name',
      'mime_type'
    ]);
    expect((image.required as string[]).sort()).toEqual(['download_url', 'file_id']);
  });

  it.each(IMAGE_TOOLS)('%s parses mobile string values without an error at the served layer', tool => {
    const shape = getZodInputShape(tool);
    const schema = z.object(shape);
    const base = {
      recipient: {
        name: 'R',
        addressLine1: '1 Main St',
        city: 'KC',
        state: 'MO',
        postalCode: '64111',
        country: 'US'
      }
    };
    const extras =
      tool === 'quote_and_preview_postcard'
        ? { message: 'hi' }
        : { bodyText: 'hi', signOff: 'bye' };
    // '' means nothing attached. Any other string names a picture the server
    // cannot open, kept as a marker so the handlers do not print an older
    // upload in its place (#414).
    const parsedEmpty = schema.parse({ ...base, ...extras, image: '' }) as { image?: unknown };
    expect(parsedEmpty.image).toBeUndefined();
    for (const value of ['attached', 'chat_upload://image_0', '/mnt/data/x.png', 'file_0000abcd']) {
      const parsed = schema.parse({ ...base, ...extras, image: value }) as { image?: unknown };
      expect(parsed.image, `string ${JSON.stringify(value)} must become the marker`).toEqual({
        download_url: '',
        file_id: UNRESOLVED_IMAGE_FILE_ID
      });
    }
    const withFile = schema.parse({
      ...base,
      ...extras,
      image: { download_url: 'https://files.example/f1', file_id: 'file_1' }
    }) as { image?: { file_id?: string } };
    expect(withFile.image?.file_id).toBe('file_1');
  });
});

describe('served file-param schemas (Apps SDK contract)', () => {
  it.each(IMAGE_TOOLS)('%s serves the exact four-property file object', tool => {
    const image = servedImageSchema(tool);
    // The contract: an object declaring ALL FOUR properties, requiring only
    // download_url and file_id. No anyOf, no bare {}, nothing else required.
    expect(image.type).toBe('object');
    expect(image.anyOf).toBeUndefined();
    expect(Object.keys((image.properties as Record<string, unknown>) ?? {}).sort()).toEqual([
      'download_url',
      'file_id',
      'file_name',
      'mime_type'
    ]);
    expect((image.required as string[]).sort()).toEqual(['download_url', 'file_id']);
  });

  it.each(IMAGE_TOOLS)('%s tolerates mobile string values without a validation error', tool => {
    // Mobile sends strings instead of file objects ('' when nothing attached;
    // 'chat_upload'/'chat_upload://image_0' per openai-apps-sdk-examples#185;
    // 'attached' observed historically). Each must parse cleanly - never a
    // zod validation error surfaced to the model. '' becomes an absent image;
    // any other string becomes the unresolved marker (#414), which the
    // handlers answer with the upload picker guidance.
    const base = {
      recipient: {
        name: 'R',
        addressLine1: '1 Main St',
        city: 'KC',
        state: 'MO',
        postalCode: '64111',
        country: 'US'
      }
    };
    const extras =
      tool === 'quote_and_preview_postcard'
        ? { message: 'hi' }
        : { bodyText: 'hi', signOff: 'bye' };
    const parsedEmpty = toolInputSchemas[tool].parse({ ...base, ...extras, image: '' }) as { image?: unknown };
    expect(parsedEmpty.image).toBeUndefined();
    for (const value of ['attached', 'chat_upload', 'chat_upload://image_0', '/mnt/data/x.png', 'file_0000abcd']) {
      const parsed = toolInputSchemas[tool].parse({ ...base, ...extras, image: value }) as {
        image?: unknown;
      };
      expect(parsed.image, `string ${JSON.stringify(value)} must become the marker`).toEqual({
        download_url: '',
        file_id: UNRESOLVED_IMAGE_FILE_ID
      });
    }
    // And a real file object passes through intact.
    const withFile = toolInputSchemas[tool].parse({
      ...base,
      ...extras,
      image: { download_url: 'https://files.example/f1', file_id: 'file_1', mime_type: 'image/png' }
    }) as { image?: { file_id?: string } };
    expect(withFile.image?.file_id).toBe('file_1');
  });
});
