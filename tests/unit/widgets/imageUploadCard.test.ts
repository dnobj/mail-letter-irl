/**
 * The photo upload card in both kinds of host (#474, phase 3).
 *
 * In ChatGPT the card keeps ChatGPT's file store: the photo goes up as it was
 * picked, and the card hands its link on. Anywhere else (Claude) there is no
 * file store for a card, so the card sends the photo itself: shrunk to a JPEG
 * of at most 2400 px, in chunks through upload_photo_chunk, and then asks for
 * the preview with a chat message. It offers that only while the server says
 * it may.
 *
 * jsdom neither decodes nor draws images, so Image and the canvas are fakes
 * that record what the card asks of them.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const CHUNK_CHARS = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Json = Record<string, any>;

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** A JPEG's base64 of this many characters, in a pattern that shows the order of its chunks. */
function base64Of(chars: number): string {
  const bytes = Buffer.alloc((chars / 4) * 3);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + (i >> 9)) % 251;
  return bytes.toString('base64');
}

interface Drawing {
  /** The picked photo's size as the browser decodes it; null for a photo it cannot read. */
  photo: { width: number; height: number } | null;
  /** The JPEG the canvas makes; null for a browser that cannot make one ("data:,"). */
  jpeg: string | null;
  canvases: Array<{ width: number; height: number; fill: string[]; drawn: number[][]; type?: string; quality?: number }>;
}

function mount(install: (window: any) => void) {
  const page = inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'ImageUploadCard.html'), 'utf-8'), WIDGET_DIR);
  const drawing: Drawing = { photo: { width: 4800, height: 3200 }, jpeg: base64Of(8), canvases: [] };
  const dom = new JSDOM(page, {
    runScripts: 'dangerously',
    beforeParse(window) {
      install(window);
      (window as any).Image = class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        set src(_value: string) {
          setImmediate(() => {
            if (!drawing.photo) return this.onerror?.();
            this.naturalWidth = drawing.photo.width;
            this.naturalHeight = drawing.photo.height;
            this.onload?.();
          });
        }
      };
      const canvasProto = (window as any).HTMLCanvasElement.prototype;
      canvasProto.getContext = function (this: any) {
        const record = { width: this.width, height: this.height, fill: [] as string[], drawn: [] as number[][] };
        drawing.canvases.push(record);
        const ctx = {
          fillStyle: '',
          fillRect: () => record.fill.push(ctx.fillStyle),
          drawImage: (_img: unknown, ...box: number[]) => record.drawn.push(box)
        };
        return ctx;
      };
      canvasProto.toDataURL = function (type: string, quality: number) {
        const record = drawing.canvases[drawing.canvases.length - 1];
        record.type = type;
        record.quality = quality;
        return drawing.jpeg === null ? 'data:,' : `data:image/jpeg;base64,${drawing.jpeg}`;
      };
    }
  });
  const window = dom.window as any;
  const document = window.document as Document;
  const el = (id: string) => document.getElementById(id) as HTMLElement;

  return {
    window,
    document,
    drawing,
    text: (id: string) => el(id).textContent?.trim() ?? '',
    shown: (id: string) => !el(id).classList.contains('hidden'),
    click: async (id: string) => {
      el(id).dispatchEvent(new window.Event('click'));
      await flush();
    },
    /** Pick a photo as the file dialog would. */
    pick: async (name = 'beach.jpg', type = 'image/jpeg', sizeBytes?: number) => {
      const file = new window.File(['not really a jpeg'], name, { type });
      if (sizeBytes !== undefined) Object.defineProperty(file, 'size', { value: sizeBytes });
      const input = el('file-input');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change'));
      await flush();
      return file;
    }
  };
}

/** The card in an MCP Apps host, as in Claude: every call a JSON-RPC request its host answers. */
async function inMcpHost(toolResult?: Json) {
  const sent: Json[] = [];
  const parent = { postMessage: (message: Json) => sent.push(JSON.parse(JSON.stringify(message))) };
  const card = mount(window => {
    Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  });
  const deliver = async (message: Json) => {
    card.window.dispatchEvent(new card.window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: parent }));
    await flush();
  };
  const requests = (method: string) => sent.filter(message => message.method === method && message.id !== undefined);
  const last = (method: string) => requests(method).at(-1);
  await flush();
  await deliver({
    id: last('ui/initialize')!.id,
    result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostCapabilities: {}, hostContext: {} }
  });
  const host = {
    ...card,
    sent,
    requests,
    /** The chunks the card has sent, in order. */
    chunks: () => requests('tools/call').filter(message => message.params.name === 'upload_photo_chunk').map(message => message.params.arguments),
    toolResult: (structuredContent: Json) => deliver({ method: 'ui/notifications/tool-result', params: { content: [], structuredContent } }),
    /** Answer the card's latest request of this kind. */
    answer: (method: string, reply: Json) => deliver({ id: last(method)!.id, ...reply }),
    /** Answer the latest chunk as the server would. */
    accept: (done: boolean) => {
      const { uploadId, index, total } = last('tools/call')!.params.arguments;
      return deliver({
        id: last('tools/call')!.id,
        result: { content: [], structuredContent: { uploadId, received: index + 1, total, done } }
      });
    }
  };
  if (toolResult) await host.toolResult(toolResult);
  return host;
}

/** Pick a photo and press Use This Photo. */
async function upload(card: Awaited<ReturnType<typeof inMcpHost>>) {
  await card.pick();
  await card.click('btn-use');
}

describe('the upload card in an MCP Apps host, as in Claude (#474)', () => {
  it('offers no upload until the server says the card may send the photo', async () => {
    const card = await inMcpHost();
    expect(card.shown('btn-select')).toBe(false);
    expect(card.shown('size-hint')).toBe(false);
    expect(card.text('upload-unavailable')).toBe("Photo upload isn't available in this app yet. Use a link to the photo instead.");
    expect(card.shown('upload-unavailable')).toBe(true);

    await card.toolResult({ context: 'postcard', cardUploadAvailable: false });
    expect(card.shown('btn-select')).toBe(false);
    expect(card.shown('upload-unavailable')).toBe(true);

    await card.toolResult({ context: 'postcard', cardUploadAvailable: true });
    expect(card.shown('btn-select')).toBe(true);
    expect(card.shown('upload-unavailable')).toBe(false);
    // It shrinks the photo first, so it takes a bigger original than ChatGPT.
    expect(card.text('size-hint')).toBe('JPEG, PNG, or WebP · Max 25 MB');
    // ChatGPT's library is not here.
    expect(card.shown('btn-library')).toBe(false);
  });

  it('shrinks the photo to 2400 px on white, and sends it in whole base64 chunks, in order, under one upload id', async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    const jpeg = base64Of(2 * CHUNK_CHARS + 100);
    card.drawing.jpeg = jpeg;
    await upload(card);

    expect(card.drawing.canvases).toEqual([
      { width: 2400, height: 1600, fill: ['#ffffff'], drawn: [[0, 0, 2400, 1600]], type: 'image/jpeg', quality: 0.88 }
    ]);
    expect(card.shown('state-uploading')).toBe(true);
    await card.accept(false);
    await card.accept(false);
    await card.accept(true);

    const chunks = card.chunks();
    expect(chunks.map(({ index, total, context }) => ({ index, total, context }))).toEqual([
      { index: 0, total: 3, context: 'postcard' },
      { index: 1, total: 3, context: 'postcard' },
      { index: 2, total: 3, context: 'postcard' }
    ]);
    expect(chunks[0].uploadId).toMatch(UUID);
    expect(new Set(chunks.map(chunk => chunk.uploadId)).size).toBe(1);
    expect(chunks.map(chunk => chunk.data.length)).toEqual([CHUNK_CHARS, CHUNK_CHARS, 100]);
    expect(chunks.map(chunk => chunk.data).join('')).toBe(jpeg);
    // Nothing of ChatGPT's file store, and no link to hand on.
    expect(card.requests('tools/call').map(message => message.params.name)).toEqual([
      'upload_photo_chunk',
      'upload_photo_chunk',
      'upload_photo_chunk'
    ]);

    // Then it asks for the preview in the conversation.
    expect(card.requests('ui/message').at(-1)!.params).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Make the postcard with the photo I just uploaded.' }]
    });
    await card.answer('ui/message', { result: {} });
    expect(card.shown('state-done')).toBe(true);
    expect(card.shown('url-box')).toBe(false);
    expect(card.text('done-note')).toBe('Uploaded. Your request for the preview is in the conversation.');
    expect((card.document.getElementById('done-img') as HTMLImageElement).src).toBe(`data:image/jpeg;base64,${jpeg}`);
  });

  it('leaves a photo smaller than 2400 px at its own size', async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    card.drawing.photo = { width: 900, height: 1200 };
    await upload(card);
    expect(card.drawing.canvases[0]).toMatchObject({ width: 900, height: 1200 });
  });

  it.each([
    ['postcard', 'Make the postcard with the photo I just uploaded.'],
    ['header_image', 'Make the letter with the photo I just uploaded as its header image.'],
    ['inline_image', 'Make the letter with the photo I just uploaded enclosed in it.'],
    [undefined, 'Make the preview with the photo I just uploaded.']
  ])('asks for the preview the upload was for (%s)', async (context, prompt) => {
    const card = await inMcpHost({ ...(context ? { context } : {}), cardUploadAvailable: true });
    await upload(card);
    expect('context' in card.chunks()[0]).toBe(context !== undefined);
    await card.accept(true);
    expect(card.requests('ui/message').at(-1)!.params.content[0].text).toBe(prompt);
  });

  it('gives the person the sentence to send when the app will not take the message', async () => {
    for (const reply of [{ error: { code: -32000, message: 'not allowed' } }, { result: { isError: true } }]) {
      const card = await inMcpHost({ context: 'header_image', cardUploadAvailable: true });
      await upload(card);
      await card.accept(true);
      await card.answer('ui/message', reply);
      expect(card.text('done-note')).toBe(
        'Uploaded. Now send this in the conversation: “Make the letter with the photo I just uploaded as its header image.”'
      );
    }
  });

  it('sends a chunk again, once, when its answer is lost on the way back', async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    await upload(card);
    await card.answer('tools/call', { error: { code: -32001, message: 'Request timed out' } });
    await card.accept(true);

    const chunks = card.chunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual(chunks[0]);
    expect(card.requests('ui/message')).toHaveLength(1);
  });

  it('stops when the chunk is lost twice, and says so in its own words, not the host’s', async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    await upload(card);
    await card.answer('tools/call', { error: { code: -32001, message: 'Request timed out' } });
    await card.answer('tools/call', { error: { code: -32001, message: 'Request timed out' } });

    expect(card.chunks()).toHaveLength(2);
    expect(card.shown('state-error')).toBe(true);
    expect(card.text('error-message')).toBe('Upload failed. Please try again.');
    expect(card.requests('ui/message')).toHaveLength(0);
  });

  it("shows the server's refusal as it is, and sends nothing more", async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    card.drawing.jpeg = base64Of(2 * CHUNK_CHARS);
    await upload(card);
    const refusal = 'This account has uploaded as many photos as it can today. Please try again tomorrow, or use a link to the photo.';
    await card.answer('tools/call', { result: { isError: true, content: [{ type: 'text', text: refusal }] } });

    expect(card.chunks()).toHaveLength(1);
    expect(card.text('error-message')).toBe(refusal);
    expect(card.requests('ui/message')).toHaveLength(0);
  });

  it('does not claim an upload the server did not finish', async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    await upload(card);
    await card.accept(false);

    expect(card.text('error-message')).toBe('The upload did not finish. Please try again.');
    expect(card.requests('ui/message')).toHaveLength(0);
  });

  it.each([
    ['cannot read the photo', (drawing: Drawing) => { drawing.photo = null; }],
    ['reads it with no size', (drawing: Drawing) => { drawing.photo = { width: 0, height: 0 }; }],
    ['cannot make a JPEG of it', (drawing: Drawing) => { drawing.jpeg = null; }]
  ])('says so when the browser %s, and sends nothing', async (_case, arrange) => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    arrange(card.drawing);
    await upload(card);

    expect(card.text('error-message')).toBe("This photo couldn't be read here. Please try a JPEG or PNG.");
    expect(card.chunks()).toHaveLength(0);
  });

  it('takes a photo of up to 25 MB', async () => {
    const card = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    await card.pick('big.jpg', 'image/jpeg', 25 * 1024 * 1024);
    expect(card.shown('state-preview')).toBe(true);

    const over = await inMcpHost({ context: 'postcard', cardUploadAvailable: true });
    await over.pick('bigger.jpg', 'image/jpeg', 26 * 1024 * 1024);
    expect(over.text('error-message')).toBe('File is too large (26.0 MB). Maximum size is 25 MB.');
  });
});

/** The card in ChatGPT: window.openai, with its file store. */
function inChatGpt(openai: Json) {
  const calls: unknown[][] = [];
  const record =
    (name: string, answer: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)(...args) : answer;
    };
  const api: Json = {
    theme: 'light',
    toolOutput: { context: 'postcard' },
    callTool: record('callTool', { structuredContent: {} }),
    sendFollowUpMessage: record('sendFollowUpMessage', undefined),
    uploadFile: record('uploadFile', { fileId: 'file_1' }),
    getFileDownloadUrl: record('getFileDownloadUrl', { downloadUrl: 'https://files.example/1' }),
    ...openai
  };
  for (const [key, value] of Object.entries(openai)) if (value === undefined) delete api[key];
  const card = mount(window => {
    window.openai = api;
  });
  return { ...card, api, calls, record };
}

describe('the upload card in ChatGPT keeps its file store (#474)', () => {
  it('uploads the photo as picked, then confirms it and asks for the preview with its link', async () => {
    const card = inChatGpt({});
    // What the server says about the card's own upload does not apply here.
    expect(card.shown('btn-select')).toBe(true);
    expect(card.shown('upload-unavailable')).toBe(false);
    expect(card.text('size-hint')).toBe('JPEG, PNG, or WebP · Max 10 MB');

    const file = await card.pick();
    await card.click('btn-use');

    expect(card.calls).toEqual([
      ['uploadFile', file],
      ['getFileDownloadUrl', { fileId: 'file_1' }],
      ['callTool', 'confirm_uploaded_image', { imageUrl: 'https://files.example/1', context: 'postcard' }],
      [
        'sendFollowUpMessage',
        { prompt: 'Image upload completed. Please call quote_and_preview_postcard with imageUrl "https://files.example/1".' }
      ]
    ]);
    expect(card.text('url-text')).toBe('https://files.example/1');
    expect(card.shown('url-box')).toBe(true);
    // No canvas: ChatGPT gets the original.
    expect(card.drawing.canvases).toHaveLength(0);
  });

  it('keeps its own path even before ChatGPT has offered its file store', async () => {
    const card = inChatGpt({ uploadFile: undefined, toolOutput: { context: 'postcard', cardUploadAvailable: false } });
    expect(card.shown('btn-select')).toBe(true);
    expect(card.shown('upload-unavailable')).toBe(false);
    card.api.uploadFile = card.record('uploadFile', { fileId: 'file_2' });

    await card.pick();
    await card.click('btn-use');
    expect(card.calls[0][0]).toBe('uploadFile');
    expect(card.calls.some(call => call[1] === 'upload_photo_chunk')).toBe(false);
  });

  it("offers ChatGPT's library once ChatGPT adds it, after the page has loaded", async () => {
    const card = inChatGpt({});
    expect(card.shown('btn-library')).toBe(false);
    card.api.selectFiles = card.record('selectFiles', []);
    card.window.dispatchEvent(new card.window.Event('openai:set_globals'));
    expect(card.shown('btn-library')).toBe(true);
  });

  it('refuses a photo over 10 MB, since ChatGPT keeps the original', async () => {
    const card = inChatGpt({});
    await card.pick('big.jpg', 'image/jpeg', 12 * 1024 * 1024);
    expect(card.text('error-message')).toBe('File is too large (12.0 MB). Maximum size is 10 MB.');
  });
});
