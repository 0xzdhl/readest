import { describe, expect, it } from 'vitest';
import { MONOTONIC_BUMP_BOUND_MS, nextMonotonicTimestamp } from '@/store/bookDataStore';

/**
 * `nextMonotonicTimestamp` backs last-write-wins for reading progress: a
 * deliberate local write must out-stamp a value the device may have just pulled
 * (so LWW picks this device), while staying anchored to wall-clock so a skewed
 * far-future pulled timestamp cannot pin the device permanently ahead.
 */
describe('nextMonotonicTimestamp', () => {
  it('uses now when there is no previous timestamp', () => {
    expect(nextMonotonicTimestamp(undefined, 1000)).toBe(1000);
    expect(nextMonotonicTimestamp(0, 1000)).toBe(1000);
  });

  it('uses now when the previous timestamp is in the past', () => {
    expect(nextMonotonicTimestamp(500, 1000)).toBe(1000);
  });

  it('bumps strictly past a tie so a deliberate local write wins LWW', () => {
    expect(nextMonotonicTimestamp(1000, 1000)).toBe(1001);
  });

  it('bumps past a slightly-ahead pulled value within the bound', () => {
    expect(nextMonotonicTimestamp(1002, 1000)).toBe(1003);
    expect(nextMonotonicTimestamp(1000 + MONOTONIC_BUMP_BOUND_MS - 1, 1000)).toBe(
      1000 + MONOTONIC_BUMP_BOUND_MS,
    );
  });

  it('ignores a far-future (skewed/bogus) value beyond the bound and resets to now', () => {
    expect(nextMonotonicTimestamp(1000 + MONOTONIC_BUMP_BOUND_MS, 1000)).toBe(1000);
    expect(nextMonotonicTimestamp(1000 + MONOTONIC_BUMP_BOUND_MS + 5000, 1000)).toBe(1000);
  });
});
