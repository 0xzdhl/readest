export const BACKUP_DIALOG_EVENT = 'backup-dialog-event';

export const setBackupDialogVisible = (visible: boolean) => {
  const dialog = document.getElementById('backup_window');
  if (dialog) {
    const event = new CustomEvent(BACKUP_DIALOG_EVENT, {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};
