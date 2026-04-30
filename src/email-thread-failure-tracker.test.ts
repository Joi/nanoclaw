import { describe, expect, it } from 'vitest';

import { ThreadFailureTracker } from './email-thread-failure-tracker.js';

describe('ThreadFailureTracker', () => {
  it('does not skip a thread that has never failed', () => {
    const tracker = new ThreadFailureTracker();
    expect(tracker.shouldSkip('thread-1')).toBe(false);
    expect(tracker.failureCount('thread-1')).toBe(0);
  });

  it('does not skip a thread below the failure threshold', () => {
    const tracker = new ThreadFailureTracker({ threshold: 3 });
    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-1');
    expect(tracker.shouldSkip('thread-1')).toBe(false);
    expect(tracker.failureCount('thread-1')).toBe(2);
  });

  it('skips a thread once it crosses the failure threshold within the backoff window', () => {
    const now = 1_000_000;
    const clock = () => now;
    const tracker = new ThreadFailureTracker({ threshold: 3, backoffMs: 60_000, clock });

    expect(tracker.recordFailure('thread-1')).toBe(1);
    expect(tracker.recordFailure('thread-1')).toBe(2);
    expect(tracker.recordFailure('thread-1')).toBe(3);

    expect(tracker.shouldSkip('thread-1')).toBe(true);
    expect(tracker.failureCount('thread-1')).toBe(3);
  });

  it('stops skipping after the backoff window elapses', () => {
    let now = 1_000_000;
    const clock = () => now;
    const tracker = new ThreadFailureTracker({ threshold: 2, backoffMs: 60_000, clock });

    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-1');
    expect(tracker.shouldSkip('thread-1')).toBe(true);

    now += 59_999;
    expect(tracker.shouldSkip('thread-1')).toBe(true);

    now += 2; // total elapsed 60_001ms — past the 60_000ms backoff
    expect(tracker.shouldSkip('thread-1')).toBe(false);
  });

  it('clear() resets a thread so it is retried immediately', () => {
    const tracker = new ThreadFailureTracker({ threshold: 2, backoffMs: 60_000 });
    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-1');
    expect(tracker.shouldSkip('thread-1')).toBe(true);

    tracker.clear('thread-1');
    expect(tracker.shouldSkip('thread-1')).toBe(false);
    expect(tracker.failureCount('thread-1')).toBe(0);
  });

  it('tracks failure counts per thread independently', () => {
    const tracker = new ThreadFailureTracker({ threshold: 3, backoffMs: 60_000 });
    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-2');

    expect(tracker.shouldSkip('thread-1')).toBe(true);
    expect(tracker.shouldSkip('thread-2')).toBe(false);
    expect(tracker.failureCount('thread-1')).toBe(3);
    expect(tracker.failureCount('thread-2')).toBe(1);
  });

  it('recordFailure returns the running count', () => {
    const tracker = new ThreadFailureTracker();
    expect(tracker.recordFailure('thread-1')).toBe(1);
    expect(tracker.recordFailure('thread-1')).toBe(2);
    expect(tracker.recordFailure('thread-1')).toBe(3);
  });

  it('uses Date.now() as the default clock', () => {
    const tracker = new ThreadFailureTracker({ threshold: 1, backoffMs: 60_000 });
    tracker.recordFailure('thread-1');
    // With threshold=1 and a real-time backoff, the thread should be skipped
    // immediately after a single failure (we only just recorded it).
    expect(tracker.shouldSkip('thread-1')).toBe(true);
  });

  it('applies sensible defaults: threshold=3, backoff=4h', () => {
    let now = 0;
    const tracker = new ThreadFailureTracker({ clock: () => now });
    tracker.recordFailure('thread-1');
    tracker.recordFailure('thread-1');
    expect(tracker.shouldSkip('thread-1')).toBe(false); // 2 < 3 (default threshold)
    tracker.recordFailure('thread-1');
    expect(tracker.shouldSkip('thread-1')).toBe(true);

    now += 4 * 60 * 60 * 1000 - 1; // just under 4h
    expect(tracker.shouldSkip('thread-1')).toBe(true);

    now += 2; // total elapsed > 4h (default backoff)
    expect(tracker.shouldSkip('thread-1')).toBe(false);
  });
});
