import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_DIALOG_EVENT, setBackupDialogVisible } from '@/app/library/components/backupDialog';

describe('setBackupDialogVisible', () => {
  afterEach(() => {
    document.getElementById('backup_window')?.remove();
    vi.restoreAllMocks();
  });

  // Regression: the Backup & Restore menu item did nothing because the event
  // was dispatched on the (not-yet-mounted) #backup_window element, while the
  // listener that MOUNTS the window lives on `window`. It must reach `window`
  // even when the element does not exist yet.
  it('dispatches the event on window even when #backup_window is not mounted', () => {
    expect(document.getElementById('backup_window')).toBeNull();

    const handler = vi.fn();
    window.addEventListener(BACKUP_DIALOG_EVENT, handler as EventListener);
    try {
      setBackupDialogVisible(true);
    } finally {
      window.removeEventListener(BACKUP_DIALOG_EVENT, handler as EventListener);
    }

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as CustomEvent<{ visible?: boolean }>;
    expect(event.detail?.visible).toBe(true);
  });

  it('carries the visible flag through to listeners', () => {
    const handler = vi.fn();
    window.addEventListener(BACKUP_DIALOG_EVENT, handler as EventListener);
    try {
      setBackupDialogVisible(false);
    } finally {
      window.removeEventListener(BACKUP_DIALOG_EVENT, handler as EventListener);
    }

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as CustomEvent<{ visible?: boolean }>;
    expect(event.detail?.visible).toBe(false);
  });
});
