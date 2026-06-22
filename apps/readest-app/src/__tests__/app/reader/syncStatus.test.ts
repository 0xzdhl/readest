import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getSyncStatus } from '@/app/reader/utils/syncStatus';

dayjs.extend(relativeTime);

// Identity-ish translator that fills {{time}} so the label text is assertable.
const _ = (key: string, vars?: Record<string, unknown>): string =>
  vars && typeof vars['time'] === 'string' ? key.replace('{{time}}', vars['time'] as string) : key;

describe('getSyncStatus', () => {
  it('prompts sign-in when signed out (problem icon, no spinner)', () => {
    const s = getSyncStatus({ signedIn: false, syncing: false, error: null, lastSyncTime: 0 }, _);
    expect(s.label).toBe('Sign in to Sync');
    expect(s.spinning).toBe(false);
    expect(s.problem).toBe(true);
  });

  it('shows Syncing… with a looping spinner while in flight', () => {
    const s = getSyncStatus(
      { signedIn: true, syncing: true, error: null, lastSyncTime: Date.now() },
      _,
    );
    expect(s.label).toBe('Syncing…');
    expect(s.spinning).toBe(true);
    expect(s.problem).toBe(false);
  });

  it('shows Sync failed (problem icon) on error when not syncing', () => {
    const s = getSyncStatus(
      { signedIn: true, syncing: false, error: 'boom', lastSyncTime: Date.now() },
      _,
    );
    expect(s.label).toBe('Sync failed');
    expect(s.spinning).toBe(false);
    expect(s.problem).toBe(true);
  });

  it('an active sync takes precedence over a stale error', () => {
    const s = getSyncStatus(
      { signedIn: true, syncing: true, error: 'old error', lastSyncTime: Date.now() },
      _,
    );
    expect(s.label).toBe('Syncing…');
    expect(s.spinning).toBe(true);
  });

  it('shows the relative synced time when idle and previously synced', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const s = getSyncStatus(
      { signedIn: true, syncing: false, error: null, lastSyncTime: fiveMinAgo },
      _,
    );
    expect(s.label).toBe(`Synced ${dayjs(fiveMinAgo).fromNow()}`);
    expect(s.spinning).toBe(false);
    expect(s.problem).toBe(false);
  });

  it('shows Never synced when idle and never synced', () => {
    const s = getSyncStatus({ signedIn: true, syncing: false, error: null, lastSyncTime: 0 }, _);
    expect(s.label).toBe('Never synced');
    expect(s.spinning).toBe(false);
    expect(s.problem).toBe(false);
  });
});
