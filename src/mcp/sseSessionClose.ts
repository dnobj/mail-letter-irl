/**
 * The close handler for a legacy SSE stream (GET on `LETTER_IRL_SSE_PATH`,
 * which is `/mcp` in both environments).
 *
 * Closing the stream's server closes its transport, and the SDK's
 * `SSEServerTransport.close()` calls `onclose` again, synchronously, before the
 * protocol has let go of the transport. A handler that closes the server on
 * `onclose` therefore calls itself until the stack overflows. That surfaced on
 * 2026-09-26 as `RangeError: Maximum call stack size exceeded` and an unhandled
 * rejection every time VS Code or Claude Code dropped the stream they open on
 * `/mcp`. ChatGPT never opens one, so nothing had exercised the path before.
 *
 * The returned handler runs once per stream: it forgets the session, then
 * closes the server. Every later call returns at once.
 */
export function closeSseSessionOnce(
  closeServer: () => Promise<void>,
  forgetSession: () => void
): () => Promise<void> {
  let closing = false;
  return async () => {
    if (closing) {
      return;
    }
    closing = true;
    forgetSession();
    await closeServer();
  };
}
