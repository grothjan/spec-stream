/**
 * ReorderBuffer — small time-window buffer that sorts incoming events by `createdAt`
 * before flushing them to a downstream handler.
 *
 * Problem context
 * ---------------
 * When an element is added on prooph board, the database trigger fires synchronously
 * within the same transaction and may insert secondary events
 * (element-details-synchronized, element-config-synced) before the transaction
 * commits.  Because all rows share the same transaction, Supabase Realtime can deliver
 * them in any order over the websocket.  If a sync event arrives before element-added
 * the local-sync projection silently drops the update (the element doesn't exist yet).
 *
 * Solution
 * --------
 * Buffer events for `windowMs` (default 80 ms).  Events that belong to the same
 * transaction burst land within that window.  On flush the buffer is sorted by
 * `createdAt` (ISO string — lexicographic sort is valid for ISO-8601), giving causal
 * order before downstream processing.
 *
 * Trade-off
 * ---------
 * Adds up to `windowMs` of latency to every event.  80 ms is imperceptible for the
 * file-sync use-case but can be tuned via the constructor.
 */

import type { ChangelogEvent } from "./realtime/events.js";

export interface ReorderBufferOptions {
  /** How long to wait (ms) before flushing accumulated events. Default: 80. */
  windowMs?: number;
  /** Downstream handler — called once per event in sorted order. */
  onEvent: (event: ChangelogEvent) => void;
  /** Injectable for tests. */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  };
}

const realTimers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
};

export class ReorderBuffer {
  private readonly windowMs: number;
  private readonly onEvent: (event: ChangelogEvent) => void;
  private readonly timers: NonNullable<ReorderBufferOptions["timers"]>;
  private pending: ChangelogEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: ReorderBufferOptions) {
    this.windowMs = opts.windowMs ?? 80;
    this.onEvent = opts.onEvent;
    this.timers = opts.timers ?? realTimers;
  }

  /** Accept an incoming event. Starts (or resets) the flush window. */
  push(event: ChangelogEvent): void {
    this.pending.push(event);
    // A running timer means we're already within a burst window — let it expire
    // naturally so all burst events collect before the sort.
    if (!this.timer) {
      this.timer = this.timers.setTimeout(() => this.flush(), this.windowMs);
    }
  }

  /** Flush all buffered events immediately, sorted by createdAt ascending. */
  flush(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;

    // ISO-8601 strings sort correctly as strings (lexicographic == chronological).
    this.pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const events = this.pending;
    this.pending = [];
    for (const ev of events) {
      this.onEvent(ev);
    }
  }

  /** Cancel any pending timer and discard buffered events (e.g. on shutdown). */
  cancel(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }
}
