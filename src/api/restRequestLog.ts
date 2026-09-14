/**
 * One value-free log line per REST request, written once its response is.
 *
 * Successful REST calls used to log nothing, so from the log a dashboard that
 * worked and one that was refused looked the same. The line names the route by
 * its id in the scope table, never by the path it was called with: paths carry
 * letter ids, promo codes and token ids.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { findRestRoute } from '../auth/restScopes.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';

export function logRestRequestOnFinish(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): void {
  const route = findRestRoute(req.method, pathname)?.id ?? 'unmatched';
  const method = req.method ?? 'UNKNOWN';
  res.once('finish', () => {
    writeDiagnostic('info', 'rest.request', { route, method, status: res.statusCode });
  });
}
