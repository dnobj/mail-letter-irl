/**
 * Comprehensive logging system for debugging ChatGPT Apps SDK OAuth flow
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'http' | 'oauth' | 'sse' | 'mcp' | 'auth' | 'error' | 'config';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: any;
  requestId?: string;
}

class Logger {
  private logs: LogEntry[] = [];
  private maxLogs = 1000; // Keep last 1000 entries
  private requestCounter = 0;

  log(level: LogLevel, category: LogCategory, message: string, data?: any, requestId?: string) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
      requestId
    };

    this.logs.push(entry);

    // Trim to max size
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Also log to console with colors
    this.consoleLog(entry);
  }

  private consoleLog(entry: LogEntry) {
    const colors = {
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m',  // Green
      warn: '\x1b[33m',  // Yellow
      error: '\x1b[31m'  // Red
    };
    const reset = '\x1b[0m';
    const color = colors[entry.level];

    const prefix = entry.requestId ? `[${entry.requestId}]` : '';
    console.log(
      `${color}[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${prefix}${reset}`,
      entry.message
    );

    if (entry.data) {
      console.log(color + '  Data:' + reset, JSON.stringify(entry.data, null, 2));
    }
  }

  debug(category: LogCategory, message: string, data?: any, requestId?: string) {
    this.log('debug', category, message, data, requestId);
  }

  info(category: LogCategory, message: string, data?: any, requestId?: string) {
    this.log('info', category, message, data, requestId);
  }

  warn(category: LogCategory, message: string, data?: any, requestId?: string) {
    this.log('warn', category, message, data, requestId);
  }

  error(category: LogCategory, message: string, data?: any, requestId?: string) {
    this.log('error', category, message, data, requestId);
  }

  getLogs(filter?: { level?: LogLevel; category?: LogCategory; since?: string }): LogEntry[] {
    let filtered = [...this.logs];

    if (filter?.level) {
      filtered = filtered.filter(log => log.level === filter.level);
    }

    if (filter?.category) {
      filtered = filtered.filter(log => log.category === filter.category);
    }

    if (filter?.since) {
      filtered = filtered.filter(log => log.timestamp >= filter.since);
    }

    return filtered;
  }

  clear() {
    this.logs = [];
    console.log('Logs cleared');
  }

  generateRequestId(): string {
    return `req-${++this.requestCounter}`;
  }
}

export const logger = new Logger();
