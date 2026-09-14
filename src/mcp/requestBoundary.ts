import type { IncomingMessage, ServerResponse } from "node:http";
import { classifyDiagnosticError, writeDiagnostic } from "../utils/diagnosticLog.js";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * One exception boundary around every request.
 *
 * `http.createServer` does nothing with the promise an async listener
 * returns, so a rejection that escapes a route handler used to become an
 * unhandled rejection, which Node ends the process on. Two unauthenticated
 * routes could reach that state (the temp-image bucket read rethrows any
 * error that is not a 404; URL parsing throws on a malformed request
 * target), and any future route can. The boundary turns an escaped error
 * into a diagnostic and a 500, or closes the socket when a response had
 * already started, and never lets it reach the process.
 */
export function withRequestBoundary(handler: RequestHandler) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let outcome: Promise<void>;
    try {
      outcome = handler(req, res);
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.catch((error: unknown) => {
      writeDiagnostic("error", "http.request_unhandled", {
        errorClass: classifyDiagnosticError(error, "unknown_error"),
        method: req.method ?? "unknown",
        headersSent: res.headersSent
      });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      try {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      } catch {
        res.destroy();
      }
    });
  };
}

/**
 * Process-level last resort. A rejection nobody awaited is logged and the
 * process keeps serving; an exception nobody caught leaves the process in
 * an unknown state, so it is logged and the process exits for the platform
 * to restart. Both are registered once.
 */
export function installProcessGuards(exit: (code: number) => void = code => process.exit(code)): void {
  const marker = "__letterIrlProcessGuards";
  const flagged = process as unknown as Record<string, unknown>;
  if (flagged[marker]) return;
  flagged[marker] = true;
  process.on("unhandledRejection", (reason: unknown) => {
    writeDiagnostic("error", "process.unhandled_rejection", {
      errorClass: classifyDiagnosticError(reason, "unknown_error")
    });
  });
  process.on("uncaughtException", (error: unknown) => {
    writeDiagnostic("error", "process.uncaught_exception", {
      errorClass: classifyDiagnosticError(error, "unknown_error")
    });
    exit(1);
  });
}
