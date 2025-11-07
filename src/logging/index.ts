import { Logger, LogEvent } from "../contracts/types.js";

type LogLevel = "info" | "warn" | "error" | "debug";

type LogSink = (level: LogLevel, message: string | undefined, event: LogEvent) => void;

type LoggerContext = Record<string, unknown>;

const REDACT_KEYS = [
  "address",
  "body",
  "signoff",
  "snapshot",
  "orders",
  "postal",
  "line1",
  "line2",
  "recipient",
  "sender"
];

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedact(key)) {
        obj[key] = "[REDACTED]";
      } else {
        obj[key] = redactValue(entry);
      }
    }
    return obj;
  }

  if (typeof value === "string") {
    return value.length > 32 ? "[REDACTED]" : value;
  }

  return value;
}

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEYS.some((token) => lower.includes(token));
}

function redactEvent(event: LogEvent): LogEvent {
  const sanitized: LogEvent = { correlationId: event.correlationId };
  for (const [key, value] of Object.entries(event)) {
    if (key === "correlationId") continue;
    sanitized[key] = redactValue(value);
  }
  return sanitized;
}

const defaultSink: LogSink = (level, message, event) => {
  const payload = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...event
  };
  const serialized = JSON.stringify(payload);
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
};

class StructuredLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly context: LoggerContext
  ) {}

  private emit(level: LogLevel, event: LogEvent, message?: string) {
    const merged: LogEvent = {
      ...this.context,
      ...event,
      correlationId: event.correlationId ?? (this.context.correlationId as string) ?? "unknown"
    } as LogEvent;
    this.sink(level, message, redactEvent(merged));
  }

  info(event: LogEvent, message?: string) {
    this.emit("info", event, message);
  }

  warn(event: LogEvent, message?: string) {
    this.emit("warn", event, message);
  }

  error(event: LogEvent, message?: string) {
    this.emit("error", event, message);
  }

  debug(event: LogEvent, message?: string) {
    this.emit("debug", event, message);
  }

  child(context: LoggerContext): Logger {
    return new StructuredLogger(this.sink, { ...this.context, ...context });
  }
}

interface LoggerOptions {
  context?: LoggerContext;
  sink?: LogSink;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const context = options.context ?? {};
  return new StructuredLogger(sink, context);
}
