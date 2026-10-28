import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'http';
import {
  classifyDiagnosticError,
  writeDiagnostic,
  type DiagnosticErrorCategory
} from '../utils/diagnosticLog.js';

/**
 * Answer a REST request that failed for a reason the caller cannot act on (#682): a fixed sentence and a reference,
 * never the error's own message, which can name a table, a constraint or a provider's reply. The error's class goes to
 * the diagnostic log with the same reference, so a reference a person quotes finds its line.
 */
export function sendInternalError(
  res: ServerResponse,
  event: string,
  error: unknown,
  message: string,
  fallback: DiagnosticErrorCategory = 'database_error'
): void {
  const reference = randomUUID();
  writeDiagnostic('error', event, { errorClass: classifyDiagnosticError(error, fallback), reference });
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Internal server error', message, reference }));
}
