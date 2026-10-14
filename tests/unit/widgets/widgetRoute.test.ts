/**
 * The /widgets web route serves only the cards this deployment serves, by
 * their own file names (#730): not the directory's notes or shared parts, not
 * a path, and not the Letter Home card while its flag is off.
 */

import type { ServerResponse } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveWidget } from '../../../src/mcp/httpServer.js';

function response() {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: (chunk?: string) => {
      body = chunk ?? '';
    }
  } as unknown as ServerResponse;
  return { res, headers, body: () => body };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the /widgets route', () => {
  it.each(['LetterPreviewCard.html', 'PostcardPreviewCard.html', 'LetterPreviewCard'])('serves a card: %s', async (name) => {
    const { res, body } = response();
    expect(await serveWidget(name, res)).toBe(true);
    expect(body()).toContain('<html');
  });

  it.each([
    'README.md',
    'README',
    'shared/hostBridge.js',
    '../package.json',
    '..%2F..%2Fpackage.json',
    'NotACard.html',
    ''
  ])('serves nothing else: %s', async (name) => {
    const { res, body } = response();
    expect(await serveWidget(name, res)).toBe(false);
    expect(body()).toBe('');
  });

  it('serves the Letter Home card only while its flag is on', async () => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', '');
    expect(await serveWidget('LetterHomeCard.html', response().res)).toBe(false);
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'true');
    expect(await serveWidget('LetterHomeCard.html', response().res)).toBe(true);
  });
});
