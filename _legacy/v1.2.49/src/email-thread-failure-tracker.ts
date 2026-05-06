/**
 * ThreadFailureTracker — circuit breaker for the Email channel poll loop.
 *
 * Background (jibot-code-r8y): the EmailChannel poll loop calls `gog gmail thread get`
 * for every unread thread on every poll. When one specific thread (e.g. one with
 * many large attachments or a very long history) consistently overflows
 * execFile's stdout buffer, the failure repeats every poll cycle indefinitely
 * — burning event-loop cycles and surfacing as cascading symptoms elsewhere
 * (e.g. Baileys init queries timing out, jibot-code-5m2).
 *
 * This tracker implements a simple per-thread circuit breaker: after a thread
 * fails N times within a backoff window, subsequent fetch attempts are skipped
 * until the window elapses. Successful fetches clear the failure record.
 *
 * State is in-memory only — restarts re-try every thread once. Per-thread
 * persistence isn't worth the complexity yet; the Email channel poll cadence
 * (15min by default after `4c489ab`) means at most a handful of retries per day.
 */

interface FailureEntry {
  count: number;
  firstFailureMs: number;
  lastFailureMs: number;
}

export interface ThreadFailureTrackerOptions {
  /** How many failures before a thread is considered persistently failing. Default: 3. */
  threshold?: number;
  /** How long to skip a persistently failing thread (ms). Default: 4h. */
  backoffMs?: number;
  /** Clock for testing. Default: Date.now. */
  clock?: () => number;
}

export class ThreadFailureTracker {
  private readonly entries = new Map<string, FailureEntry>();
  private readonly threshold: number;
  private readonly backoffMs: number;
  private readonly clock: () => number;

  constructor(opts: ThreadFailureTrackerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.backoffMs = opts.backoffMs ?? 4 * 60 * 60 * 1000;
    this.clock = opts.clock ?? Date.now;
  }

  /** True if the threadId has failed >= threshold times and is still inside the backoff window. */
  shouldSkip(threadId: string): boolean {
    const entry = this.entries.get(threadId);
    if (!entry) return false;
    if (entry.count < this.threshold) return false;
    return (this.clock() - entry.lastFailureMs) < this.backoffMs;
  }

  /** Record a failure for the threadId; returns the running failure count. */
  recordFailure(threadId: string): number {
    const now = this.clock();
    const existing = this.entries.get(threadId);
    if (existing) {
      existing.count++;
      existing.lastFailureMs = now;
      return existing.count;
    }
    this.entries.set(threadId, {
      count: 1,
      firstFailureMs: now,
      lastFailureMs: now,
    });
    return 1;
  }

  /** Clear the failure record for a thread (call on successful fetch). */
  clear(threadId: string): void {
    this.entries.delete(threadId);
  }

  /** Current failure count for a thread (0 if never failed or already cleared). */
  failureCount(threadId: string): number {
    return this.entries.get(threadId)?.count ?? 0;
  }
}
