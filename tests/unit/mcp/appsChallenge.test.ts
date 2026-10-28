import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { APPS_CHALLENGE_PATH, appsChallengeResponse } from '../../../src/mcp/appsChallenge.js';

/**
 * The plugin portal's domain verification (#407): the portal fetches its token
 * from /.well-known/openai-apps-challenge on the MCP host and expects that
 * token and nothing else.
 */
describe('the plugin portal domain challenge', () => {
  const TOKEN = 'oai-apps-challenge-3f9c2d7e';

  it('answers with the configured token exactly: plain text, no newline, never cached', () => {
    const answer = appsChallengeResponse('GET', { OPENAI_APPS_CHALLENGE_TOKEN: TOKEN });
    expect(answer).toEqual({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      body: TOKEN
    });
  });

  it('trims whitespace pasted around the token', () => {
    expect(appsChallengeResponse('GET', { OPENAI_APPS_CHALLENGE_TOKEN: `  ${TOKEN}\n` }).body).toBe(TOKEN);
  });

  it('answers HEAD with the headers and no body', () => {
    const answer = appsChallengeResponse('HEAD', { OPENAI_APPS_CHALLENGE_TOKEN: TOKEN });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('');
  });

  it('is not found until a token is configured, and for other methods', () => {
    for (const env of [{}, { OPENAI_APPS_CHALLENGE_TOKEN: '' }, { OPENAI_APPS_CHALLENGE_TOKEN: '   ' }]) {
      expect(appsChallengeResponse('GET', env)).toEqual({ status: 404, headers: { 'Cache-Control': 'no-store' }, body: '' });
    }
    for (const method of ['POST', 'PUT', 'DELETE', undefined]) {
      expect(appsChallengeResponse(method, { OPENAI_APPS_CHALLENGE_TOKEN: TOKEN }).status).toBe(404);
    }
  });

  it('is served by the HTTP server at the path the portal fetches, before authentication', async () => {
    expect(APPS_CHALLENGE_PATH).toBe('/.well-known/openai-apps-challenge');
    const source = await readFile('src/mcp/httpServer.ts', 'utf8');
    const route = source.indexOf('url.pathname === APPS_CHALLENGE_PATH');
    expect(route).toBeGreaterThan(-1);
    const block = source.slice(route, source.indexOf('return;', route));
    expect(block).toContain('appsChallengeResponse(req.method)');
    expect(block).toContain('res.writeHead(answer.status, answer.headers)');
    expect(block).toContain('res.end(answer.body)');
    // Among the open probes, ahead of anything that authenticates.
    expect(route).toBeLessThan(source.indexOf('url.pathname === "/readyz"'));
    expect(route).toBeGreaterThan(source.indexOf('url.pathname === "/healthz"'));
  });
});
