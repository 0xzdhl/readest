export const BACKUP_DIALOG_EVENT = 'backup-dialog-event';

export const setBackupDialogVisible = (visible: boolean) => {
  // Dispatch on `window`, not on the `#backup_window` element: the element is
  // mounted lazily by the library page only AFTER it sees this event, so on the
  // first open the element does not exist yet. Both listeners (the library
  // page's lazy-mount trigger and the BackupWindow's own open/close handler)
  // live on `window`, so this reaches them on the first click and every time.
  const event = new CustomEvent(BACKUP_DIALOG_EVENT, {
    detail: { visible },
  });
  window.dispatchEvent(event);
};
