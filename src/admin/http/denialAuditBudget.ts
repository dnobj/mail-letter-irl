import { createHash, randomUUID } from "node:crypto";

import type { AdminAuditEventInput } from "../contracts.js";

/**
 * The per-minute budget for individual denial rows in admin_audit_events,
 * and what happens beyond it.
 *
 * The pipeline used to cap denial rows at sixty a minute and then drop the
 * rest silently (audit A-15). A burst of denials is the shape of a probing
 * tailnet peer or an operator locked out of elevation, so the minutes with
 * missing rows were exactly the minutes that mattered. The cap itself is
 * right, since a flood must not turn the audit table into the amplifier; what
 * was wrong was the silence.
 *
 * Beyond the budget, denials are counted, by error code and by distinct
 * actor, and written as one `admin.request_denied_burst` row per window:
 * at the first denial of the following window, and at shutdown, so nothing
 * counted is lost while the process lives. The budget is a fixed window
 * rather than a sliding one so "per minute" means what the row says.
 */
export interface DenialBurstSummary {
  windowStartedAt: string;
  windowMs: number;
  limit: number;
  written: number;
  suppressed: number;
  byCode: Record<string, number>;
  distinctActors: number;
}

export type DenialBurstSink = (summary: DenialBurstSummary) => Promise<void>;

const MAX_TRACKED_ACTORS = 1000;

export class DenialAuditBudget {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private sink: DenialBurstSink | null = null;
  private windowStart: number;
  private written = 0;
  private suppressed = 0;
  private byCode = new Map<string, number>();
  private actors = new Set<string>();

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
    this.windowStart = this.now();
  }

  /** Where burst rows go. The request pipeline sets this once; it owns the audit writer. */
  setSink(sink: DenialBurstSink): void {
    this.sink = sink;
  }

  /**
   * Ask before writing an individual denial row. True: write it. False: the
   * budget for this window is spent and the denial was counted instead.
   */
  async admit(actorId: string, code: string): Promise<boolean> {
    await this.rolloverIfDue();
    if (this.written < this.limit) {
      this.written += 1;
      return true;
    }
    this.count(actorId, code);
    return false;
  }

  /** Count a denial that another limiter already refused to write individually. */
  async suppress(actorId: string, code: string): Promise<void> {
    await this.rolloverIfDue();
    this.count(actorId, code);
  }

  /** Write the pending burst row, if there is one. Called at shutdown. */
  async flush(): Promise<void> {
    const pending = this.take();
    if (pending && this.sink) await this.sink(pending);
  }

  private count(actorId: string, code: string): void {
    this.suppressed += 1;
    this.byCode.set(code, (this.byCode.get(code) ?? 0) + 1);
    if (this.actors.size < MAX_TRACKED_ACTORS) this.actors.add(actorId);
  }

  private take(): DenialBurstSummary | null {
    if (this.suppressed === 0) return null;
    const summary: DenialBurstSummary = {
      windowStartedAt: new Date(this.windowStart).toISOString(),
      windowMs: this.windowMs,
      limit: this.limit,
      written: this.written,
      suppressed: this.suppressed,
      byCode: Object.fromEntries(this.byCode),
      distinctActors: this.actors.size,
    };
    this.suppressed = 0;
    this.byCode = new Map();
    this.actors = new Set();
    return summary;
  }

  private async rolloverIfDue(): Promise<void> {
    const at = this.now();
    if (at - this.windowStart < this.windowMs) return;
    const pending = this.take();
    this.windowStart = at;
    this.written = 0;
    if (pending && this.sink) await this.sink(pending);
  }
}

/** The audit row for one window's suppressed denials. */
export function denialBurstEvent(
  summary: DenialBurstSummary,
): Omit<AdminAuditEventInput, "environment" | "mode"> {
  return {
    // Not an operator: the row stands for every actor counted in the window,
    // and distinctActors says how many that was.
    actor: { id: "aggregate@admin-panel", name: "denial burst" },
    sessionIdHash: createHash("sha256").update(`burst:${summary.windowStartedAt}`).digest("hex"),
    correlationId: randomUUID(),
    action: "admin.request_denied_burst",
    targetType: "process",
    inputSummary: { ...summary },
    outcome: "denied",
    // The contract requires a stable code on every denied row; this one is
    // never thrown, it names the burst. The real codes are in byCode.
    errorCode: "ADMIN_DENIAL_BURST",
  };
}
