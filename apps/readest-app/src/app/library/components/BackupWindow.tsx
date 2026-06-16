import React, { useEffect, useState } from 'react';
import { Effect } from 'effect';
import {
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiUploadCloud2Line,
  RiDownloadCloud2Line,
} from 'react-icons/ri';
import { usePlatformInfo, useBooted } from '@/context/EffectRuntimeProvider';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { useFileSelector } from '@/hooks/useFileSelector';
import { restoreFromBackupZip, saveBackupFile } from '@/services/backupService';
import { useLibraryStore } from '@/store/libraryStore';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { FileSystem } from '@/application/ports/FileSystem';
import Dialog from '@/components/Dialog';
import { BoxedList, NavigationRow } from '@/components/settings/primitives';
import { BACKUP_DIALOG_EVENT } from './backupDialog';

type BackupStatus = 'idle' | 'backing-up' | 'restoring' | 'completed' | 'error';

interface BackupProgress {
  current: number;
  total: number;
  currentFile?: string;
}

interface BackupResult {
  type: 'backup' | 'restore';
  booksAdded?: number;
  booksUpdated?: number;
}

interface BackupWindowProps {
  onPullLibrary: (fullRefresh?: boolean, verbose?: boolean) => void;
  initialVisible?: boolean;
}

export const BackupWindow: React.FC<BackupWindowProps> = ({
  onPullLibrary,
  initialVisible = false,
}) => {
  const _ = useTranslation();
  const booted = useBooted();
  const platformInfo = usePlatformInfo();
  const runEffect = useRunEffect();
  const { setLibrary } = useLibraryStore();
  const { selectFiles } = useFileSelector(_);
  const [isOpen, setIsOpen] = useState(initialVisible);
  const [status, setStatus] = useState<BackupStatus>('idle');
  const [progress, setProgress] = useState<BackupProgress>({ current: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<BackupResult | null>(null);

  const resetState = () => {
    setStatus('idle');
    setProgress({ current: 0, total: 0 });
    setErrorMessage('');
    setResult(null);
  };

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
      if (event.detail.visible) {
        resetState();
      }
    };

    window.addEventListener(BACKUP_DIALOG_EVENT, handleCustomEvent as EventListener);

    return () => {
      window.removeEventListener(BACKUP_DIALOG_EVENT, handleCustomEvent as EventListener);
    };
  }, []);

  const handleBackup = async () => {
    if (!booted) return;

    setStatus('backing-up');
    setErrorMessage('');
    setProgress({ current: 0, total: 0 });

    try {
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `readest-backup-${timestamp}.zip`;
      const saved = await saveBackupFile(filename, (current, total, currentFile) => {
        setProgress({ current, total, currentFile });
      });
      if (saved) {
        setResult({ type: 'backup' });
        setStatus('completed');
      } else {
        setStatus('idle');
      }
    } catch (error) {
      console.error('Backup failed:', error);
      setErrorMessage(_('Backup failed: {{error}}', { error: String(error) }));
      setStatus('error');
    }
  };

  const handleRestore = async () => {
    if (!booted) return;

    try {
      const result = await selectFiles({
        type: 'generic',
        accept: '.zip',
        extensions: ['zip'],
        dialogTitle: _('Select Backup'),
      });
      if (!result.files.length) return;

      setStatus('restoring');
      setErrorMessage('');
      setProgress({ current: 0, total: 0 });

      const zipFile = result.files[0]?.file
        ? result.files[0].file
        : await runEffect(
            Effect.flatMap(FileSystem, (fs) => fs.openFile(result.files[0]!.path!, 'None')),
          );

      const { booksAdded, booksUpdated } = await restoreFromBackupZip(
        zipFile,
        (current, total, currentFile) => {
          setProgress({ current, total, currentFile });
        },
      );

      const newLibrary = await runEffect(Effect.flatMap(LibraryRepository, (r) => r.load));
      const booksCount = newLibrary.reduce((sum, book) => sum + (book.deletedAt ? 0 : 1), 0);
      setLibrary(newLibrary);
      setResult({
        type: 'restore',
        booksAdded: Math.min(booksAdded, booksCount),
        booksUpdated: Math.min(booksUpdated, booksCount),
      });
      setStatus('completed');
      onPullLibrary(true);
    } catch (error) {
      console.error('Restore failed:', error);
      setErrorMessage(_('Restore failed: {{error}}', { error: String(error) }));
      setStatus('error');
    }
  };

  const handleClose = () => {
    if (status === 'backing-up' || status === 'restoring') {
      return;
    }
    setIsOpen(false);
    resetState();
  };

  const progressPercentage =
    progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const isProcessing = status === 'backing-up' || status === 'restoring';

  return (
    <Dialog
      id='backup_window'
      isOpen={isOpen}
      title={_('Backup & Restore')}
      onClose={handleClose}
      snapHeight={platformInfo.isMobile ? 0.45 : undefined}
      dismissible={!isProcessing}
      boxClassName='sm:!w-[520px] sm:!max-w-screen-sm sm:h-auto'
    >
      {isOpen && (
        <div className='backup-content flex flex-col gap-6 pb-4 pt-2'>
          {/* Title lives in the Dialog header bar; here we only need the
              one-line description so it isn't shown twice. */}
          <p className='text-base-content/70 px-1 leading-relaxed'>
            {_(
              'Save a copy of your library or restore from an earlier backup. Restoring merges with your current library.',
            )}
          </p>

          {/* Idle: the two on-system actions */}
          {status === 'idle' && (
            <BoxedList>
              <NavigationRow
                icon={RiUploadCloud2Line}
                title={_('Backup Library')}
                status={_('Create a backup file you can save anywhere.')}
                onClick={handleBackup}
              />
              <NavigationRow
                icon={RiDownloadCloud2Line}
                title={_('Restore Library')}
                status={_('Import books and notes from a backup file.')}
                onClick={handleRestore}
              />
            </BoxedList>
          )}

          {/* In progress: token-based progress bar + current/total + status */}
          {isProcessing && (
            <div className='eink-bordered border-base-200 bg-base-100 flex flex-col gap-3 rounded-lg border p-4'>
              <div className='flex items-center justify-between gap-3'>
                <span className='text-base-content font-medium'>
                  {status === 'backing-up' ? _('Creating backup...') : _('Restoring library...')}
                </span>
                <span className='text-base-content/70 text-[0.85em] tabular-nums'>
                  {progressPercentage}%
                </span>
              </div>

              <div
                className='bg-base-200 h-2 w-full overflow-hidden rounded-full'
                role='progressbar'
                aria-valuenow={progressPercentage}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className='bg-primary h-2 rounded-full transition-all duration-300'
                  style={{ width: `${progressPercentage}%` }}
                />
              </div>

              <div className='flex flex-col gap-1'>
                <p className='text-base-content/70 text-[0.85em] tabular-nums'>
                  {_('{{current}} of {{total}} items', {
                    current: progress.current.toLocaleString(),
                    total: progress.total.toLocaleString(),
                  })}
                </p>
                {progress.currentFile && (
                  <p
                    className='text-base-content/60 overflow-hidden font-mono text-[0.8em]'
                    style={{
                      direction: 'rtl',
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {progress.currentFile}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Success: calm result summary */}
          {status === 'completed' && result && (
            <div className='eink-bordered border-base-200 bg-base-100 flex items-start gap-3 rounded-lg border p-4'>
              <RiCheckboxCircleFill className='text-success mt-0.5 h-5 w-5 flex-shrink-0' />
              <div className='flex min-w-0 flex-col gap-1'>
                <span className='text-base-content font-medium'>
                  {result.type === 'backup'
                    ? _('Backup completed successfully!')
                    : _('Restore completed successfully!')}
                </span>
                <span className='text-base-content/70 text-[0.85em] leading-relaxed'>
                  {result.type === 'backup'
                    ? _('Your library has been saved to the selected location.')
                    : _('{{added}} books added, {{updated}} books updated.', {
                        added: result.booksAdded ?? 0,
                        updated: result.booksUpdated ?? 0,
                      })}
                </span>
              </div>
            </div>
          )}

          {/* Error: inline, token error color */}
          {status === 'error' && errorMessage && (
            <div className='eink-bordered border-error/40 bg-base-100 flex items-start gap-3 rounded-lg border p-4'>
              <RiErrorWarningFill className='text-error mt-0.5 h-5 w-5 flex-shrink-0' />
              <div className='flex min-w-0 flex-col gap-1'>
                <span className='text-base-content font-medium'>{_('Operation failed')}</span>
                <span className='text-error break-words text-[0.85em] leading-relaxed'>
                  {errorMessage}
                </span>
              </div>
            </div>
          )}

          {/* Footer actions */}
          {status === 'completed' || status === 'error' ? (
            <div className='flex gap-3'>
              <button className='btn btn-ghost flex-1' onClick={handleClose}>
                {_('Close')}
              </button>
              {status === 'error' && (
                <button className='btn btn-primary flex-1' onClick={resetState}>
                  {_('Try Again')}
                </button>
              )}
            </div>
          ) : (
            !isProcessing && (
              <div className='flex'>
                <button className='btn btn-ghost flex-1' onClick={handleClose}>
                  {_('Cancel')}
                </button>
              </div>
            )
          )}
        </div>
      )}
    </Dialog>
  );
};
