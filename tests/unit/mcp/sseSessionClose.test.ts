import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { closeSseSessionOnce } from '../../../src/mcp/sseSessionClose.js';

/**
 * The legacy SSE stream's close handler, against the real SDK server and
 * transport (2026-09-26: every dropped VS Code or Claude Code stream on /mcp
 * logged `RangeError: Maximum call stack size exceeded`). The response is the
 * only fake: enough of a ServerResponse for the transport to start and to hear
 * the client go away.
 */

class FakeResponse extends EventEmitter {
  ended = 0;
  writeHead() {
    return this;
  }
  write() {
    return true;
  }
  end() {
    this.ended += 1;
    return this;
  }
}

async function openStream(onclose: (server: McpServer, transport: SSEServerTransport) => () => Promise<void>) {
  const res = new FakeResponse();
  const server = new McpServer({ name: 'sse-close-test', version: '0.0.0' });
  const transport = new SSEServerTransport('/messages', res as unknown as ServerResponse);
  // Set before connect, as httpServer.ts does: the SDK then wraps it.
  transport.onclose = onclose(server, transport);
  await server.connect(transport);
  return { res, server, transport };
}

describe('the legacy SSE close handler', () => {
  // Expected noise: V8 prints "Exception in PromiseRejectCallback ... RangeError"
  // to stderr for this case. That is the overflow being reproduced, not a failure.
  it('reproduces the loop without the guard: closing the server re-enters onclose until the stack overflows', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const { res } = await openStream((server) => () => {
      calls += 1;
      // Caught here only so the test runner sees no unhandled rejection; the
      // recursion itself is exactly the pre-fix handler's.
      return server.close().catch((error: unknown) => {
        errors.push(error);
      });
    });

    res.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBeGreaterThan(100);
    expect(errors.some((error) => error instanceof RangeError)).toBe(true);
  });

  it('closes the server once and forgets the session once when the client drops the stream', async () => {
    let closes = 0;
    let forgets = 0;
    const { res } = await openStream((server) =>
      closeSseSessionOnce(
        async () => {
          closes += 1;
          await server.close();
        },
        () => {
          forgets += 1;
        }
      )
    );

    res.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closes).toBe(1);
    expect(forgets).toBe(1);
  });

  it('also runs once when the server side closes first', async () => {
    let closes = 0;
    let forgets = 0;
    const { server, res } = await openStream((srv) =>
      closeSseSessionOnce(
        async () => {
          closes += 1;
          await srv.close();
        },
        () => {
          forgets += 1;
        }
      )
    );

    await server.close();
    res.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closes).toBe(1);
    expect(forgets).toBe(1);
    expect(res.ended).toBeGreaterThanOrEqual(1);
  });

  it('is the handler httpServer.ts installs on the legacy SSE transport', () => {
    const source = readFileSync(new URL('../../../src/mcp/httpServer.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /sseTransport\.onclose = closeSseSessionOnce\(\s*\(\) => sessionServer\.close\(\),\s*\(\) => sseSessions\.delete\(sseTransport\.sessionId\)\s*\);/
    );
    // No other assignment of the handler, which could bring the loop back.
    expect(source.match(/sseTransport\.onclose\s*=/g)).toHaveLength(1);
  });
});
